import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let pending: { url: string; origin: string; at: number } | null = null;
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

vi.mock('../src/background/ima', () => ({ hasImaCredentials: vi.fn(async () => false) }));
vi.mock('../src/background/page', () => ({ extractPage: mocks.extractPage }));
vi.mock('../src/background/runner', () => ({ handleIntent: vi.fn(), abortRun: vi.fn(), recoverInterruptedRun: mocks.getSession }));

import { buildPanelState, onActionClicked } from '../src/background/router';

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
