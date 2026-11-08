import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let pending: { url: string; origin: string; at: number; quote?: string } | null = null;
  let session: Record<string, unknown> | null = null;
  return {
    openPanel: vi.fn(async () => {}),
    extractPage: vi.fn(async () => {
      throw new Error('正文不应在打开侧栏时读取');
    }),
    setPending: vi.fn(async (_tabId: number, value: typeof pending) => {
      pending = value;
    }),
    getPending: vi.fn(async () => pending),
    getSession: vi.fn(async () => session),
    setSession: (value: Record<string, unknown> | null) => {
      session = value;
    },
    ima: false,
    feishu: false,
    config: {} as Record<string, unknown>,
    reset: () => {
      pending = null;
      session = null;
    },
  };
});

vi.mock('wxt/browser', () => ({
  browser: {
    sidePanel: { open: mocks.openPanel },
    tabs: { get: vi.fn(async () => ({ url: 'https://example.com/article' })) },
  },
}));

vi.mock('../src/background/store', () => ({
  OUTBOUND_NOTICE_VERSION: '2026-09-19.2',
  hasOutboundConfirmation: vi.fn(() => true),
  readConfig: vi.fn(async () => ({
    ...mocks.config,
    provider: 'deepseek',
    apiKeys: { deepseek: 'sk-configured' },
    outbound: {
      version: '2026-09-19.2',
      receiver: 'DeepSeek（深度求索）',
      acceptedAt: 1,
    },
  })),
  getSession: mocks.getSession,
  getPending: mocks.getPending,
  setPending: mocks.setPending,
  putSession: vi.fn(async () => {}),
}));

vi.mock('../src/background/ima', () => ({ hasImaCredentials: vi.fn(async () => mocks.ima) }));
vi.mock('../src/background/feishu', () => ({ hasFeishuCredentials: vi.fn(async () => mocks.feishu) }));
vi.mock('../src/background/page', () => ({ extractPage: mocks.extractPage }));
vi.mock('../src/background/runner', () => ({ handleIntent: vi.fn(), abortRun: vi.fn(), recoverInterruptedRun: mocks.getSession }));

import { buildPanelState, onActionClicked, onContextMenuAsk } from '../src/background/router';

describe('工具栏打开侧栏', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it('已有 Key 和外发确认时，也等用户点阅读入口才提取正文', async () => {
    await onActionClicked({ id: 42, url: 'https://example.com/article' });

    expect(mocks.openPanel).toHaveBeenCalledWith({ tabId: 42 });
    expect(mocks.setPending).toHaveBeenCalledWith(42, expect.objectContaining({
      url: 'https://example.com/article',
      origin: 'https://example.com',
    }));
    expect(mocks.extractPage).not.toHaveBeenCalled();
    const state = await buildPanelState(42);
    expect(state.phase).toBe('READY_TO_START');
    expect(state.outboundConfirmed).toBe(true);
  });

  it('换页后再次点工具栏，侧栏识别新页的临时读取权', async () => {
    mocks.setSession({
      url: 'https://example.com/old',
      title: '',
      state: 'STALE',
      run: null,
      error: null,
    });

    await onActionClicked({ id: 42, url: 'https://next.example/article' });

    const state = await buildPanelState(42);
    expect(state.pageUrl).toBe('https://next.example/article');
    expect(state.permission).toBe('granted');
    expect(state.phase).toBe('STALE');
    expect(mocks.extractPage).not.toHaveBeenCalled();
  });
});

describe('右键“问 WebKnow AI”', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it('还没读这一页：打开侧栏、记下划词，不读取也不发送正文', async () => {
    await onContextMenuAsk({ id: 42, url: 'https://example.com/article' }, '这一段我看不懂，想问问');
    expect(mocks.openPanel).toHaveBeenCalledWith({ tabId: 42 });
    expect(mocks.extractPage).not.toHaveBeenCalled();
    const state = await buildPanelState(42);
    expect(state.phase).toBe('READY_TO_START');
    expect(state.quote?.text).toBe('这一段我看不懂，想问问');
  });
});

describe('三期：回答里可显示的网页原图', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it('只公开 AI 读过的那几张，没读过或非网页地址的不公开', async () => {
    mocks.setSession({
      id: 's', url: 'https://example.com/article', title: 't', state: 'READY', fingerprint: 'f', chat: [], guide: null,
      completeness: null, learning: null,
      blocks: [{ id: 'b_0', role: 'paragraph', content: '正文' }, { id: 'img_0', role: 'image', content: '图上读到（可能有误）：…' }],
      pictures: [
        { id: 'img_0', url: 'https://cdn.example.com/a.png', alt: 'a', anchor: {} },
        { id: 'img_1', url: 'https://cdn.example.com/b.png', alt: 'b', anchor: {} },
      ],
    });
    const state = await buildPanelState(42);
    expect(state.pictures).toEqual([{ id: 'img_0', src: 'https://cdn.example.com/a.png', alt: 'a' }]);
  });
});

describe('四期：收藏存到哪', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });
  const target = async (ima: boolean, feishu: boolean, config: Record<string, unknown>) => {
    Object.assign(mocks, { ima, feishu, config });
    return (await buildPanelState(42)).settings.saveTo;
  };

  it('都没连：没有收藏位置', async () => {
    expect(await target(false, false, {})).toBeNull();
  });
  it('只连了飞书且选好知识库：存飞书', async () => {
    expect(await target(false, true, { feishu: { spaceName: '读书' } })).toEqual({ target: 'feishu', name: '读书' });
  });
  it('两家都连上：按用户选的；没选默认 ima', async () => {
    const both = { ima: { kbName: 'A' }, feishu: { spaceName: 'B' } };
    expect(await target(true, true, both)).toEqual({ target: 'ima', name: 'A' });
    expect(await target(true, true, { ...both, saveTarget: 'feishu' })).toEqual({ target: 'feishu', name: 'B' });
  });
  it('连了飞书但还没选知识库：不能收藏', async () => {
    expect(await target(false, true, { feishu: {} })).toBeNull();
  });
});
