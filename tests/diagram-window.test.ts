import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  tabs: { get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  windows: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));
vi.mock('wxt/browser', () => ({ browser: {
  tabs: api.tabs, windows: api.windows,
  runtime: { getURL: (path: string) => `chrome-extension://webknow${path}` },
  storage: { session: {
    get: async (key: string | null) => key ? { [key]: api.data[key] } : { ...api.data },
    set: async (data: Record<string, unknown>) => { Object.assign(api.data, data); },
    remove: async (keys: string | string[]) => { for (const key of [keys].flat()) delete api.data[key]; },
  } },
} }));

import { openDiagram } from '../src/sidepanel/diagram-window';
import { cleanupDiagrams, clearDiagramViews } from '../src/background/diagram-cleanup';
import { matchesDiagramViewer, parseDiagramRecord } from '../src/core/diagram-record';

const draft = { svg: '<svg viewBox="0 0 2400 200"></svg>', title: '研究流程', sourceTabId: 7, sourceWindowId: 1 };

beforeEach(() => {
  vi.resetAllMocks(); api.data = {};
  api.tabs.get.mockImplementation(async (id: number) => ({ id, windowId: id === 7 ? 1 : 2, status: 'complete' }));
  api.windows.create.mockResolvedValue({ id: 2, tabs: [{ id: 20, windowId: 2 }] });
  api.tabs.create.mockResolvedValue({ id: 21, windowId: 1 });
  api.tabs.remove.mockResolvedValue(undefined);
});

describe('点图直接打开独立空间', () => {
  it('先保存会话记录再创建最大化窗口，URL 只包含随机 ID', async () => {
    api.windows.create.mockImplementation(async (details) => {
      const saved = Object.values(api.data)[0] as { svg: string };
      expect(saved.svg).toBe(draft.svg);
      expect(details).toMatchObject({ type: 'popup', state: 'maximized' });
      expect(details.url).not.toContain('svg');
      return { id: 2, tabs: [{ id: 20, windowId: 2 }] };
    });
    await openDiagram(draft);
    expect(api.windows.update).toHaveBeenCalledWith(2, { focused: true });
    expect(Object.values(api.data)[0]).toMatchObject({ ...draft, viewerTabId: 20, viewerWindowId: 2 });
  });
  it('独立窗口失败时回退为来源窗口的整页标签', async () => {
    api.windows.create.mockRejectedValue(new Error('popup denied'));
    await openDiagram(draft);
    expect(api.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: 1, active: false }));
    expect(api.tabs.update).toHaveBeenCalledWith(21, { active: true });
    expect(Object.values(api.data)[0]).toMatchObject({ viewerTabId: 21, viewerWindowId: 1 });
  });
  it('重复点同一张图只聚焦已有窗口', async () => {
    await openDiagram(draft);
    await openDiagram(draft);
    expect(api.windows.create).toHaveBeenCalledTimes(1);
    expect(api.tabs.update).toHaveBeenCalledWith(20, { active: true });
  });
  it('两种打开方式均失败时清掉临时记录，允许用户重试', async () => {
    api.windows.create.mockRejectedValue(new Error('popup denied'));
    api.tabs.create.mockRejectedValue(new Error('tab denied'));
    await expect(openDiagram(draft)).rejects.toThrow();
    expect(api.data).toEqual({});
  });
  it('图表关闭只清图表记录，不影响文章会话', async () => {
    await openDiagram(draft); api.data['sess:7'] = { chat: ['保留'] };
    await cleanupDiagrams({ tabId: 20 });
    expect(api.data).toEqual({ 'sess:7': { chat: ['保留'] } });
  });
  it('来源关闭时清记录，保留已经打开的图表供用户继续查看', async () => {
    await openDiagram(draft);
    await cleanupDiagrams({ tabId: 7 });
    expect(api.data).toEqual({});
    expect(api.tabs.remove).not.toHaveBeenCalled();
  });
  it('其他标签关闭不会删掉正在创建的图表记录', async () => {
    const id = crypto.randomUUID();
    api.data[`diagram:${id}`] = { ...draft, id, createdAt: Date.now() };
    await cleanupDiagrams({ tabId: 50 });
    expect(api.data[`diagram:${id}`]).toBeTruthy();
  });
  it('关闭图表或来源窗口都清记录', async () => {
    await openDiagram(draft);
    await cleanupDiagrams({ windowId: 2 });
    expect(api.data).toEqual({});
    await openDiagram(draft);
    await cleanupDiagrams({ windowId: 1 });
    expect(api.data).toEqual({});
  });
  it('用户清掉文章记录时，也关闭该文章的独立图表', async () => {
    await openDiagram(draft);
    await clearDiagramViews(7);
    expect(api.tabs.remove).toHaveBeenCalledWith(20);
    expect(api.data).toEqual({});
  });
});

describe('图表来源校验', () => {
  it('只接受自家 viewer 路径、对应 ID 和绑定的标签窗口', async () => {
    await openDiagram(draft);
    const record = parseDiagramRecord(Object.values(api.data)[0])!;
    const url = `chrome-extension://webknow/viewer.html?diagram=${record.id}`;
    const viewer = { id: 20, windowId: 2 };
    expect(matchesDiagramViewer(record, viewer, url, 'chrome-extension://webknow/viewer.html')).toBe(true);
    for (const forged of [url.replace('webknow', 'another'), url.replace('viewer.html', 'options.html'), url.replace(record.id, 'fake')]) {
      expect(matchesDiagramViewer(record, viewer, forged, 'chrome-extension://webknow/viewer.html')).toBe(false);
    }
    expect(matchesDiagramViewer(record, { id: 22, windowId: 2 }, url, 'chrome-extension://webknow/viewer.html')).toBe(false);
    expect(matchesDiagramViewer(record, { id: 20, windowId: 1 }, url, 'chrome-extension://webknow/viewer.html')).toBe(false);
  });
  it('损坏记录不被认作可用来源', () => {
    expect(parseDiagramRecord({ ...draft, id: 'fake', sourceTabId: '7' })).toBeNull();
  });
});
