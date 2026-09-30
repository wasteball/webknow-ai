import { beforeEach, describe, expect, it, vi } from 'vitest';

const tabs = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn() }));
const getViews = vi.hoisted(() => vi.fn());
const sessionGet = vi.hoisted(() => vi.fn());
vi.mock('wxt/browser', () => ({
  browser: { storage: { session: { get: sessionGet } }, tabs, extension: { getViews }, runtime: { getURL: (path: string) => `chrome-extension://webknow${path}` } },
}));

import { activeTabId } from '../src/sidepanel/api';

beforeEach(() => {
  vi.resetAllMocks();
  tabs.get.mockResolvedValue({ id: 7, windowId: 1 });
  getViews.mockReturnValue([]);
  sessionGet.mockResolvedValue({});
});

describe('设置页保留来源文章', () => {
  it('没有 tabs 权限看不到 URL 时，从自家扩展视图识别设置页', async () => {
    tabs.query.mockResolvedValue([{ id: 9, windowId: 1 }]);
    getViews.mockReturnValue([{ location: { href: 'chrome-extension://webknow/options.html?tab=7#search' } }]);
    expect(await activeTabId()).toBe(7);
  });

  it.each(['url', 'pendingUrl'])('设置页的 %s 指向原文章时，侧栏继续附着原文章', async (field) => {
    tabs.query.mockResolvedValue([{ id: 9, windowId: 1, [field]: 'chrome-extension://webknow/options.html?tab=7#search' }]);
    expect(await activeTabId()).toBe(7);
  });

  it.each([
    'https://example.com/options.html?tab=7',
    'chrome-extension://another/options.html?tab=7',
    'chrome-extension://webknow/options.html?tab=7invalid',
    'chrome-extension://webknow/options.html',
  ])('其它页面或无效来源不改变当前标签：%s', async (url) => {
    tabs.query.mockResolvedValue([{ id: 9, windowId: 1, url }]);
    expect(await activeTabId()).toBe(9);
  });

  it('原文章已关闭或属于另一窗口时，不继续附着', async () => {
    tabs.query.mockResolvedValue([{ id: 9, windowId: 1, url: 'chrome-extension://webknow/options.html?tab=7' }]);
    tabs.get.mockRejectedValueOnce(new Error('No tab'));
    expect(await activeTabId()).toBe(9);
    tabs.get.mockResolvedValueOnce({ id: 7, windowId: 2 });
    expect(await activeTabId()).toBe(9);
  });
});

const diagramId = '10000000-0000-4000-8000-000000000001';
const diagramRecord = { id: diagramId, svg: '<svg></svg>', title: '流程', createdAt: 1,
  sourceTabId: 7, sourceWindowId: 1, viewerTabId: 9, viewerWindowId: 1, mode: 'tab' };

describe('整页图表保留来源文章', () => {
  it('验证记录绑定后继续使用来源文章，而非图表标签', async () => {
    tabs.query.mockResolvedValue([{ id: 9, windowId: 1, url: `chrome-extension://webknow/viewer.html?diagram=${diagramId}` }]);
    sessionGet.mockResolvedValue({ [`diagram:${diagramId}`]: diagramRecord });
    expect(await activeTabId()).toBe(7);
  });
  it('伪造同 ID 的其他标签不会关联来源', async () => {
    tabs.query.mockResolvedValue([{ id: 10, windowId: 1, url: `chrome-extension://webknow/viewer.html?diagram=${diagramId}` }]);
    sessionGet.mockResolvedValue({ [`diagram:${diagramId}`]: diagramRecord });
    expect(await activeTabId()).toBe(10);
  });
  it('来源不存在或已移到别的窗口时，不接受记录', async () => {
    tabs.query.mockResolvedValue([{ id: 9, windowId: 1, url: `chrome-extension://webknow/viewer.html?diagram=${diagramId}` }]);
    sessionGet.mockResolvedValue({ [`diagram:${diagramId}`]: diagramRecord });
    tabs.get.mockResolvedValue({ id: 7, windowId: 3 });
    expect(await activeTabId()).toBe(9);
  });
});
