import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSession } from '../src/core/session';

const storage = vi.hoisted(() => {
  let session: PageSession | null = null;
  return {
    get: vi.fn(async () => session ? structuredClone(session) : null),
    put: vi.fn(async (next: PageSession) => { session = structuredClone(next); }),
    seed: (next: PageSession) => { session = structuredClone(next); },
    callModel: vi.fn(),
    readPageIdentity: vi.fn(async () => ({ url: 'https://example.com/article', fingerprint: 'fp' })),
    open: vi.fn(async () => {}),
    config: vi.fn(async () => ({ provider: 'deepseek', apiKeys: { deepseek: 'test-only' } })),
    pending: vi.fn(async (): Promise<null> => null),
  };
});
vi.mock('wxt/browser', () => ({ browser: {
  tabs: { get: vi.fn(async () => ({ url: 'https://example.com/article' })) },
  sidePanel: { open: storage.open },
} }));
vi.mock('../src/background/store', () => ({
  getSession: storage.get, putSession: storage.put,
  readConfig: storage.config,
  hasOutboundConfirmation: vi.fn(() => true), getPending: storage.pending,
}));
vi.mock('../src/background/model', () => ({
  callModel: storage.callModel, assertOutboundConfirmation: vi.fn(),
}));
vi.mock('../src/background/page', () => ({ readPageIdentity: storage.readPageIdentity,
  toAppError: (error: unknown) => error,
}));
vi.mock('../src/background/ima', () => ({ hasImaCredentials: vi.fn(async () => false) }));

import { appError } from '../src/core/errors';
import { emptySession } from '../src/core/session';
import { abortRun, handleIntent } from '../src/background/runner';
import { buildPanelState, notifyTab, onQuoteSelected, registerPanelPort } from '../src/background/router';

const result = { answer: '只有三个团队。', source: 'original', citations: ['b_0'], unanswered: [], references: [], followUps: [] };
const hooks = { onState: vi.fn(), onProgress: vi.fn() };
function ready(): PageSession {
  return { ...emptySession(7, 'https://example.com/article'), state: 'READY', fingerprint: 'fp',
    blocks: [{ id: 'b_0', role: 'paragraph', content: '样本只有三个团队。', headingPath: [],
      anchor: { sessionAnchorId: 'a0', selector: 'p', exact: '样本只有三个团队。', prefix: '', suffix: '', headingPath: [], fingerprint: 'fp' } }],
    guide: { summary: '三个团队的试点。', bubbles: [] },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  storage.seed(ready());
  storage.put.mockReset().mockImplementation(async (next) => { storage.seed(next); });
  storage.callModel.mockReset().mockResolvedValue(result);
  storage.open.mockReset().mockResolvedValue(undefined);
  storage.config.mockReset().mockResolvedValue({ provider: 'deepseek', apiKeys: { deepseek: 'test-only' } });
  storage.pending.mockReset().mockResolvedValue(null);
});

describe('request lifecycle recovery', () => {
  it.each(['answer', 'guide', 'learn'] as const)('recovers an interrupted %s run without losing existing chat', async (kind) => {
    const session = ready();
    session.run = { id: 'orphan', kind, startedAt: Date.now() };
    session.state = kind === 'guide' ? 'ANALYZING' : kind === 'learn' ? 'LEARNING' : 'READY';
    session.chat = [{ id: 'old', question: '已有问题', answer: '已有回答', source: 'original', citations: [], unanswered: [], references: [], at: 1 }];
    storage.seed(session);
    const state = await buildPanelState(7);
    expect(state.busy).toBeNull();
    expect(state.chat[0]?.answer).toBe('已有回答');
    expect(state.error?.retryable).toBe(true);
    expect((await storage.get())?.run).toBeNull();
    expect(storage.callModel).not.toHaveBeenCalled();
  });

  it('keeps a live request busy and finishes with exactly one stored answer', async () => {
    let finish!: (value: unknown) => void;
    storage.callModel.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const running = handleIntent({ kind: 'ask', tabId: 7, question: '有几个团队？' }, hooks);
    await vi.waitFor(() => expect(storage.callModel).toHaveBeenCalledOnce());
    expect((await buildPanelState(7)).busy?.kind).toBe('answer');
    finish(result);
    expect(await running).toBeNull();
    const state = await buildPanelState(7);
    expect(state.busy).toBeNull();
    expect(state.chat).toHaveLength(1);
    expect(state.error).toBeNull();
  });

  it('starts a fresh Ask AI topic without sending the previous topic history', async () => {
    await handleIntent({ kind: 'ask', tabId: 7, question: '文章讲了什么？' }, hooks);
    storage.callModel.mockClear();
    await handleIntent({ kind: 'ask', tabId: 7, question: '换个主题，限制是什么？' }, hooks);

    const payload = JSON.parse(storage.callModel.mock.calls[0]![0][1].content.split('\n')[1]);
    expect(payload.history).toEqual([]);
    const chat = (await storage.get())?.chat ?? [];
    expect(chat).toHaveLength(2);
    expect(chat[0]?.topicId).not.toBe(chat[1]?.topicId);
  });

  it('a failed guide keeps the extracted page usable for ask and learning', async () => {
    storage.seed({ ...ready(), guide: null });
    storage.callModel.mockResolvedValueOnce({ invalid: true }).mockResolvedValue(result);

    expect(await handleIntent({ kind: 'guide', tabId: 7 }, hooks)).toMatchObject({ code: 'BAD_OUTPUT' });
    const afterGuide = (await storage.get())!;
    expect(afterGuide.state).toBe('READY');
    expect(afterGuide.blocks).toHaveLength(1);
    expect(afterGuide.guide).toBeNull();
    expect(afterGuide.run).toBeNull();
    expect(afterGuide.error?.retryable).toBe(true);

    expect(await handleIntent({ kind: 'ask', tabId: 7, question: '有几个团队？' }, hooks)).toBeNull();
    expect((await storage.get())?.chat).toHaveLength(1);
  });

  it('stopping a guide with extracted blocks keeps the page readable', async () => {
    storage.seed({ ...ready(), guide: null });
    storage.callModel.mockImplementation((_messages, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(appError('ABORTED', '已停止')));
    }));
    const running = handleIntent({ kind: 'guide', tabId: 7 }, hooks);
    await vi.waitFor(() => expect(storage.callModel).toHaveBeenCalledOnce());
    expect(abortRun(7)).toBe(true);
    expect((await running)?.code).toBe('ABORTED');
    const state = await buildPanelState(7);
    expect(state.sessionState).toBe('READY');
    expect(state.busy).toBeNull();
    expect(state.guide).toBeNull();
    expect(state.error).toBeNull();
  });  it('a previous page still unwinding cannot block the new page guide', async () => {
    let finishOld!: (value: unknown) => void;
    storage.callModel.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const old = handleIntent({ kind: 'ask', tabId: 7, question: '旧页问题' }, hooks);
    await vi.waitFor(() => expect(storage.callModel).toHaveBeenCalledOnce());
    abortRun(7);
    const replacement = { ...ready(), id: 'new-page', state: 'ANALYZING' as const, guide: null };
    storage.seed(replacement);
    storage.callModel.mockResolvedValue({ summary: '新页面摘要', bubbles: [] });
    try {
      expect(await handleIntent({ kind: 'guide', tabId: 7 }, hooks)).toBeNull();
      expect((await storage.get())?.state).toBe('READY');
      expect((await storage.get())?.guide?.summary).toBe('新页面摘要');
    } finally { finishOld(result); await old; }
    expect((await storage.get())?.id).toBe('new-page');
    expect((await storage.get())?.guide?.summary).toBe('新页面摘要');
  });

  it('two simultaneous submissions start only one model request', async () => {
    const finishes: ((value: unknown) => void)[] = [];
    storage.callModel.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
    const first = handleIntent({ kind: 'ask', tabId: 7, question: '第一个问题' }, hooks);
    const second = handleIntent({ kind: 'ask', tabId: 7, question: '第二个问题' }, hooks);
    try {
      await vi.waitFor(() => expect(storage.callModel).toHaveBeenCalledOnce());
    } finally {
      finishes.forEach((finish) => finish(result));
      await Promise.all([first, second]);
    }
  });

  it('does not mistake final storage cleanup for a worker interruption', async () => {
    let release!: () => void;
    let ending = false;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    storage.put.mockImplementationOnce(async (next) => { storage.seed(next); });
    storage.put.mockImplementation(async (next) => {
      if (next.run === null && next.chat.length > 0) { ending = true; await pause; }
      storage.seed(next);
    });
    const running = handleIntent({ kind: 'ask', tabId: 7, question: '有几个团队？' }, hooks);
    await vi.waitFor(() => expect(ending).toBe(true));
    let observed: Awaited<ReturnType<typeof buildPanelState>> | undefined;
    const probing = buildPanelState(7).then((state) => { observed = state; });
    try {
      await vi.waitFor(() => expect(observed?.busy?.kind).toBe('answer'));
      expect(observed?.error).toBeNull();
    } finally { release(); await Promise.all([running, probing]); }
  });

  it('stop clears the active run through the normal cleanup path', async () => {
    storage.callModel.mockImplementation((_messages, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(appError('ABORTED', '已停止')));
    }));
    const running = handleIntent({ kind: 'ask', tabId: 7, question: '有几个团队？' }, hooks);
    await vi.waitFor(() => expect(storage.callModel).toHaveBeenCalledOnce());
    expect(abortRun(7)).toBe(true);
    expect((await running)?.code).toBe('ABORTED');
    const state = await buildPanelState(7);
    expect(state.busy).toBeNull();
    expect(state.error).toBeNull();
    expect(state.chat).toHaveLength(0);
  });
});

describe('quote delivery and state ordering', () => {
  it('does not wait for the native panel opening promise before saving a quote', async () => {
    let opened!: () => void;
    storage.open.mockImplementation(() => new Promise<void>((resolve) => { opened = resolve; }));
    const saving = onQuoteSelected(7, '只有三个团队');
    try {
      await vi.waitFor(async () => expect((await storage.get())?.quote?.text).toBe('只有三个团队'));
    } finally { opened(); await saving; }
  });

  it('a completed answer does not clear a newer quote, even when its text is identical', async () => {
    const text = '只有三个团队';
    storage.seed({ ...ready(), quote: { id: 'first', text, blockId: 'b_0' } });
    let finish!: (value: unknown) => void;
    storage.callModel.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const running = handleIntent({ kind: 'ask', tabId: 7, question: '什么意思？', quote: text, quoteId: 'first' }, hooks);
    await vi.waitFor(() => expect(storage.callModel).toHaveBeenCalledOnce());
    const during = (await storage.get())!;
    storage.seed({ ...during, quote: { id: 'second', text, blockId: 'b_0' } });
    finish(result);
    await running;
    const stored = (await storage.get())!;
    expect(stored.quote?.id).toBe('second');
    expect(stored.chat[0]?.quote?.id).toBe('first');
  });

  it('a same-text selection before model startup keeps its separate identity', async () => {
    const text = '只有三个团队';
    storage.seed({ ...ready(), quote: { id: 'first', text, blockId: 'b_0' } });
    let release!: (config: { provider: string; apiKeys: { deepseek: string } }) => void;
    storage.config.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const running = handleIntent({ kind: 'ask', tabId: 7, question: '什么意思？', quote: text, quoteId: 'first' }, hooks);
    await vi.waitFor(() => expect(storage.config).toHaveBeenCalledOnce());
    storage.seed({ ...ready(), quote: { id: 'second', text, blockId: 'b_0' } });
    release({ provider: 'deepseek', apiKeys: { deepseek: 'test-only' } });
    await running;
    const stored = (await storage.get())!;
    expect(stored.quote?.id).toBe('second');
    expect(stored.chat[0]?.quote?.id).toBe('first');
  });

  it('an explicitly unquoted question does not accidentally reuse the stored selection', async () => {
    storage.seed({ ...ready(), quote: { text: '只有三个团队', blockId: 'b_0' } });
    await handleIntent({ kind: 'ask', tabId: 7, question: '说明整个试点', quote: null }, hooks);
    const payload = JSON.parse(storage.callModel.mock.calls[0]![0][1].content.split('\n')[1]);
    expect(payload.quote ?? null).toBeNull();
    expect((await storage.get())?.chat[0]?.quote).toBeUndefined();
  });

  function attachPort() {
    const events: { type: string; state?: { chat: { answer: string }[] }; quote?: { text: string } }[] = [];
    let receive!: (message: unknown) => void;
    let disconnect!: () => void;
    registerPanelPort({ postMessage: (message) => events.push(message as typeof events[number]),
      onMessage: { addListener: (fn) => { receive = fn; } },
      onDisconnect: { addListener: (fn) => { disconnect = fn; } } });
    receive({ id: 1, command: { type: 'attach', tabId: 7 } });
    return { events, disconnect: () => disconnect() };
  }

  it('delivers the validated quote before a slow full-state rebuild', async () => {
    const port = attachPort();
    await vi.waitFor(() => expect(port.events.some((event) => event.type === 'reply')).toBe(true));
    let resume!: (config: { provider: string; apiKeys: { deepseek: string } }) => void;
    storage.config.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve; }));
    const saving = onQuoteSelected(7, '只有三个团队');
    try {
      await vi.waitFor(() => expect(port.events.find((event) => event.type === 'quote')?.quote?.text).toBe('只有三个团队'));
    } finally {
      resume({ provider: 'deepseek', apiKeys: { deepseek: 'test-only' } });
      await saving;
      port.disconnect();
    }
  });

  it('does not deliver an older state snapshot after the final answer state', async () => {
    const port = attachPort();
    await vi.waitFor(() => expect(port.events.some((event) => event.type === 'reply')).toBe(true));
    let resume!: (pending: null) => void;
    storage.pending.mockClear().mockImplementationOnce(() => new Promise<null>((resolve) => { resume = resolve; }));
    const older = notifyTab(7);
    await vi.waitFor(() => expect(storage.pending).toHaveBeenCalledOnce());
    storage.seed({ ...ready(), chat: [{ id: 'new', question: '新问题', answer: '最终回答', source: 'original', citations: [], references: [], unanswered: [], at: 1 }] });
    await notifyTab(7);
    resume(null);
    await older;
    expect(port.events.filter((event) => event.type === 'state').at(-1)?.state?.chat[0]?.answer).toBe('最终回答');
    port.disconnect();
  });
});
