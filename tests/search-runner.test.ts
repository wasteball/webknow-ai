import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PageSession } from '../src/core/session';
import type { AgentCheckpoint, AgentEvent, AgentOutcome } from '../src/core/search/agent-types';
import type { Config } from '../src/background/store';

const storage = vi.hoisted(() => {
  let session: PageSession | null = null;
  return {
    get: vi.fn(async () => session ? structuredClone(session) : null),
    put: vi.fn(async (next: PageSession) => { session = structuredClone(next); }),
    seed: (next: PageSession) => { session = structuredClone(next); },
    research: vi.fn(), model: vi.fn(), extract: vi.fn(),
    config: vi.fn<() => Promise<Config>>(),
    identity: vi.fn(async () => ({ url: 'https://example.com/article', fingerprint: 'fp' })),
  };
});
vi.mock('../src/background/store', () => ({ getSession: storage.get, putSession: storage.put,
  readConfig: storage.config, hasOutboundConfirmation: () => true, getPending: vi.fn(async () => null) }));
vi.mock('../src/background/model', () => ({ callModel: storage.model, assertOutboundConfirmation: vi.fn() }));
vi.mock('../src/background/research', async (original) => ({
  ...await original<Record<string, unknown>>(), executeResearch: storage.research,
}));
vi.mock('../src/background/page', () => ({ readPageIdentity: storage.identity, extractPage: storage.extract, toAppError: (e: unknown) => e }));
vi.mock('../src/background/ima', () => ({ hasImaCredentials: vi.fn(async () => false) }));
vi.mock('wxt/browser', () => ({ browser: { tabs: { get: vi.fn(async () => ({ url: 'https://example.com/article' })) }, permissions: { contains: vi.fn(async () => true) } } }));
import { emptySession } from '../src/core/session';
import { abortRun, handleIntent, recoverInterruptedRun } from '../src/background/runner';
const hooks = { onState: vi.fn(), onProgress: vi.fn(), onAgent: vi.fn() };
function ready(): PageSession {
  return { ...emptySession(7, 'https://example.com/article'), state: 'READY', fingerprint: 'fp',
    blocks: [{ id: 'b_0', role: 'paragraph', content: '样本只有三个团队。', headingPath: [],
      anchor: { sessionAnchorId: 'a0', selector: 'p', exact: '样本只有三个团队。', prefix: '', suffix: '', headingPath: [], fingerprint: 'fp' } }],
    guide: { summary: '三个团队的试点。', bubbles: [] } };
}
function finished(checkpoint: AgentCheckpoint): AgentOutcome {
  return { kind: 'finished', checkpoint: { ...checkpoint, waiting: null }, degraded: false,
    answer: { type: 'finish_answer', answer: '样本只有三个团队。', source: 'original',
      citations: ['b_0'], references: [], unanswered: [], freshness: 'not_applicable' } };
}
function waiting(checkpoint: AgentCheckpoint): AgentOutcome {
  const question = { type: 'ask_user' as const, question: '你指的是哪个版本？', reason: 'ambiguous_entity' as const };
  return { kind: 'waiting', checkpoint: { ...checkpoint, waiting: question }, question };
}
const ask = () => handleIntent({ kind: 'ask', tabId: 7, question: '查证这一结论', network: 'force' }, hooks);
async function resume(runId?: string) {
  const session = (await storage.get())!;
  return handleIntent({ kind: 'resolveResearch', tabId: 7, sessionId: session.id,
    runId: runId ?? session.run!.id, mode: 'continue', text: '产品 A' }, hooks);
}
beforeEach(() => {
  vi.clearAllMocks();
  storage.seed(ready());
  storage.config.mockResolvedValue({ provider: 'deepseek', search: { providerId: 'firecrawl', agent: { enabled: true } } });
  storage.identity.mockResolvedValue({ url: 'https://example.com/article', fingerprint: 'fp' });
  storage.research.mockReset().mockImplementation(async (checkpoint) => finished(checkpoint));
  storage.model.mockResolvedValue({ answer: '只有三个团队。', source: 'original', citations: ['b_0'], unanswered: [], references: [] });
});
afterEach(async () => { abortRun(7); await recoverInterruptedRun(7); });

describe('research lifecycle through handleIntent', () => {
  it.each(['fingerprint', 'url', 'model', 'provider', 'thinking'] as const)('rejects late results after %s changes', async (change) => {
    let complete!: (value: AgentOutcome) => void;
    let checkpoint!: AgentCheckpoint;
    storage.research.mockImplementation((input) => { checkpoint = input; return new Promise(resolve => { complete = resolve; }); });
    const running = ask();
    await vi.waitFor(() => expect(storage.research).toHaveBeenCalledOnce());
    if (change === 'fingerprint') storage.identity.mockResolvedValue({ url: 'https://example.com/article', fingerprint: 'edited' });
    if (change === 'url') storage.identity.mockResolvedValue({ url: 'https://example.com/other', fingerprint: 'fp' });
    if (change === 'model') storage.config.mockResolvedValue({ models: { deepseek: 'other-model' }, search: { agent: { enabled: true } } });
    if (change === 'provider') storage.config.mockResolvedValue({ provider: 'zhipu', search: { agent: { enabled: true } } });
    if (change === 'thinking') storage.config.mockResolvedValue({ thinking: { deepseek: { 'deepseek-flash': 'high' } }, search: { agent: { enabled: true } } });
    complete(finished(checkpoint)); await running;
    expect((await storage.get())?.chat).toHaveLength(0);
    expect((await storage.get())?.researchCheckpoint).toBeUndefined();
  });
  it('returns from waiting, retains the logical run and resumes it once under duplicate clicks', async () => {
    storage.research.mockImplementationOnce(async input => waiting(input));
    expect(await ask()).toBeNull();
    const paused = (await storage.get())!;
    expect(paused.researchPending?.status).toBe('waiting');
    expect(paused.run?.id).toBe(paused.researchCheckpoint?.snapshot.identity.runId);
    expect((await recoverInterruptedRun(7))?.run?.id).toBe(paused.run?.id);
    let complete!: (value: AgentOutcome) => void;
    storage.research.mockImplementationOnce(input => new Promise(resolve => { complete = () => resolve(finished(input)); }));
    const first = resume(); const duplicate = resume();
    await vi.waitFor(() => expect(storage.research).toHaveBeenCalledTimes(2));
    complete(finished(paused.researchCheckpoint!)); await Promise.all([first, duplicate]);
    expect((await storage.get())?.chat).toHaveLength(1);
    expect((await storage.get())?.run).toBeNull();
    expect(storage.research.mock.calls[1]?.[0].snapshot.identity.runId).toBe(paused.run?.id);
  });
  it('rejects a forged run ID without consuming the pending question', async () => {
    storage.research.mockImplementationOnce(async input => waiting(input)); await ask();
    expect((await resume('forged'))?.code).toBe('STALE_PAGE');
    expect((await storage.get())?.researchPending?.status).toBe('waiting');
    expect(storage.research).toHaveBeenCalledOnce();
  });
  it('stops waiting and preserves original question and clarification', async () => {
    storage.research.mockImplementationOnce(async input => waiting(input)); await ask();
    expect(abortRun(7)).toBe(true); await recoverInterruptedRun(7);
    const stopped = (await storage.get())!;
    expect(stopped.run).toBeNull(); expect(stopped.researchCheckpoint).toBeUndefined();
    expect(stopped.researchPending).toMatchObject({ question: '查证这一结论', status: 'stopped', clarification: { question: '你指的是哪个版本？' } });
  });
  it('recognizes expired-waiting sentinel without storing a fallback answer or extending deadline', async () => {
    storage.research.mockImplementationOnce(async input => waiting(input)); await ask();
    storage.research.mockImplementationOnce(async checkpoint => ({ ...finished(checkpoint), checkpoint, degraded: true }));
    await resume();
    const expired = (await storage.get())!;
    expect(expired.chat).toHaveLength(0); expect(expired.run).toBeNull();
    expect(expired.researchPending?.status).toBe('interrupted');
    expect(expired.researchPending?.clarification?.question).toBe('你指的是哪个版本？');
  });
  it('recovers orphaned research without replay, retaining question but clearing raw evidence', async () => {
    storage.research.mockImplementationOnce(async input => waiting(input)); await ask();
    const paused = (await storage.get())!;
    storage.seed({ ...paused, id: 'worker-orphan' });
    const recovered = await recoverInterruptedRun(7);
    expect(recovered?.run).toBeNull(); expect(recovered?.researchCheckpoint).toBeUndefined();
    expect(recovered?.researchPending?.status).toBe('interrupted'); expect(storage.research).toHaveBeenCalledOnce();
  });
  it.each([{}, { search: { providerId: 'firecrawl' } }])('global network defaults off even for force and legacy provider config %j', async config => {
    storage.config.mockResolvedValue(config); await ask();
    expect(storage.research).not.toHaveBeenCalled();
    expect((await storage.get())?.chat[0]?.answer).toContain('未联网核验');
    expect(storage.model).not.toHaveBeenCalled();
  });
  it('article-scoped answer cannot use remembered external current facts', async () => {
    await handleIntent({ kind: 'ask', tabId: 7, question: '解释文中样本', network: 'article' }, hooks);
    expect(storage.research).not.toHaveBeenCalled();
    expect(storage.model.mock.calls[0]?.[0][0].content).toContain('本题仅依据文章');
    expect((await storage.get())?.chat[0]?.answer).toContain('未联网核验');
  });
  it('ignores obsolete and non-increasing agent events', async () => {
    storage.research.mockImplementation(async (checkpoint: AgentCheckpoint, _signal: AbortSignal, emit: (e: AgentEvent) => void) => {
      const event: AgentEvent = { identity: checkpoint.snapshot.identity, seq: 2, phase: 'searching', searches: 1, reads: 0, reason: 'initial' };
      emit(event); emit({ ...event, seq: 1 }); emit({ ...event, seq: 3, identity: { ...event.identity, runId: 'forged' } });
      await new Promise(resolve => setTimeout(resolve, 10)); return finished(checkpoint);
    });
    await ask(); expect(hooks.onAgent).toHaveBeenCalledTimes(1);
  });
});

it('panel attach interrupts waiting research without replay and hides checkpoint, policy and source body', async () => {
  storage.research.mockImplementationOnce(async checkpoint => waiting({ ...checkpoint,
    ledger: { ...checkpoint.ledger, sources: [{ sourceId: 'sr_secret', title: '来源', url: 'https://example.org/report', domain: 'example.org',
      snippet: '公开摘要', provider: 'firecrawl', attempts: [], publishedAt: null, retrievedAt: new Date().toISOString(),
      content: 'SECRET_SOURCE_BODY', readStatus: 'read', decision: 'candidate', dateStatus: 'date_unknown', warnings: [] }] } }));
  await ask();
  const { buildPanelState, registerPanelPort } = await import('../src/background/router');
  const panel = await buildPanelState(7);
  expect(panel.researchPending?.status).toBe('waiting');
  const serialized = JSON.stringify(panel);
  expect(serialized).not.toContain('researchCheckpoint'); expect(serialized).not.toContain('SECRET_SOURCE_BODY');
  expect(serialized).not.toContain('answerPolicy');
  let receive!: (message: unknown) => void;
  const port = { onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: vi.fn() }, postMessage: vi.fn() };
  registerPanelPort(port); receive({ id: 1, command: { type: 'attach', tabId: 7 } });
  await vi.waitFor(async () => expect((await storage.get())?.researchPending?.status).toBe('interrupted'));
  expect((await storage.get())?.run).toBeNull(); expect(storage.research).toHaveBeenCalledOnce();
});

it('expires registered waiting without needing a resume click', async () => {
  storage.research.mockImplementationOnce(async input => waiting({ ...input, deadlineAt: Date.now() - 1 }));
  await ask();
  const state = await recoverInterruptedRun(7);
  expect(state?.run).toBeNull(); expect(state?.researchPending?.status).toBe('interrupted');
  expect(state?.researchPending?.clarification?.question).toBe('你指的是哪个版本？');
  expect(storage.research).toHaveBeenCalledOnce();
});

it('stop command releases waiting immediately and pushes a stopped state without replay', async () => {
  storage.research.mockImplementationOnce(async input => waiting(input));
  const { registerPanelPort } = await import('../src/background/router');
  let receive!: (message: unknown) => void;
  const port = { onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: vi.fn() }, postMessage: vi.fn() };
  registerPanelPort(port);
  receive({ id: 1, command: { type: 'attach', tabId: 7 } });
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
  await ask();
  receive({ id: 2, command: { type: 'stop', tabId: 7 } });
  await vi.waitFor(async () => expect((await storage.get())?.researchPending?.status).toBe('stopped'));
  expect((await storage.get())?.run).toBeNull();
  expect(port.postMessage.mock.calls.some(([event]) => event.type === 'state' && event.state.researchPending?.status === 'stopped')).toBe(true);
});

it('keeps a newly selected quote when the older waiting research completes', async () => {
  const session = ready();
  session.quote = { id: 'sent-quote', text: '样本只有三个团队。', blockId: 'b_0' };
  storage.seed(session);
  storage.research.mockImplementationOnce(async input => waiting(input)); await ask();
  const paused = (await storage.get())!;
  storage.seed({ ...paused, quote: { ...session.quote, id: 'new-quote' } });
  await resume();
  const done = (await storage.get())!;
  expect(done.chat[0]?.quote?.id).toBe('sent-quote'); expect(done.quote?.id).toBe('new-quote');
});

it('freezes the current query URL before research starts on the same article', async () => {
  storage.identity.mockResolvedValue({ url: 'https://example.com/article?view=full', fingerprint: 'fp' });
  expect(await ask()).toBeNull();
  expect((await storage.get())?.chat).toHaveLength(1);
  expect(storage.research.mock.calls[0]?.[0].snapshot.identity.url).toBe('https://example.com/article?view=full');
});

it('adopts edited article content before freezing the research snapshot', async () => {
  const page = ready();
  storage.identity.mockResolvedValue({ url: page.url, fingerprint: 'edited' });
  storage.extract.mockResolvedValue({ url: page.url, title: '改稿', fingerprint: 'edited', completeness: page.completeness,
    blocks: [{ ...page.blocks[0], content: '新内容只有两个团队。' }] });
  expect(await ask()).toBeNull();
  expect(storage.research.mock.calls[0]?.[0].snapshot.identity.fingerprint).toBe('edited');
  expect(storage.research.mock.calls[0]?.[0].snapshot.blocks[0]?.content).toBe('新内容只有两个团队。');
});

it('permission removal invalidates a waiting logical run without a resume request', async () => {
  storage.research.mockImplementationOnce(async checkpoint => waiting(checkpoint));
  await ask();
  const { onPermissionsRemoved } = await import('../src/background/router');
  await onPermissionsRemoved();
  expect((await storage.get())?.run).toBeNull();
  expect((await storage.get())?.researchPending?.status).toBe('interrupted');
  expect(storage.research).toHaveBeenCalledOnce();
});
it('permission removal aborts running research and rejects its late result', async () => {
  let release!: () => void;
  storage.research.mockImplementation(async (checkpoint: AgentCheckpoint, signal: AbortSignal) => {
    await new Promise<void>(resolve => { release = resolve; });
    expect(signal.aborted).toBe(true);
    return finished(checkpoint);
  });
  const pending = ask();
  await vi.waitFor(() => expect(storage.research).toHaveBeenCalledOnce());
  const { onPermissionsRemoved } = await import('../src/background/router');
  await onPermissionsRemoved(); release(); await pending;
  expect((await storage.get())?.chat).toEqual([]);
  expect((await storage.get())?.run).toBeNull();
});

it('router exposes current safe event details during running and resume, suppressing stale and stopped events', async () => {
  const { researchSummary } = await import('../src/core/search/answer');
  const { recordSearch } = await import('../src/core/search/evidence');
  const { buildPanelState } = await import('../src/background/router');
  let emit!: (event: AgentEvent) => void;
  let release!: () => void;
  let current!: AgentCheckpoint;
  storage.research.mockImplementation((checkpoint: AgentCheckpoint, _signal: AbortSignal, onEvent: typeof emit) => {
    current = checkpoint; emit = onEvent;
    return new Promise(resolve => { release = () => resolve(waiting(checkpoint)); });
  });
  const publish = (seq: number, query: string) => {
    const ledger = recordSearch(current.ledger, { type: 'search_web', query, purpose: 'latest', freshness: 'live', language: 'en', domains: [], maxResults: 5 },
      { status: 'ok', results: [{ title: 'Atlas', url: 'https://example.org/release', snippet: 'Public summary' }], provider: 'bocha', retrievedAt: new Date().toISOString(), warnings: [] }, 'search');
    ledger.sources[0]!.content = 'PRIVATE_SOURCE_BODY';
    return { identity: current.snapshot.identity, seq, phase: 'checking' as const, searches: 1, reads: 0, reason: 'insufficient' as const,
      details: researchSummary({ ...current, ledger }) };
  };
  const running = ask();
  await vi.waitFor(() => expect(storage.research).toHaveBeenCalledTimes(1));
  const first = publish(1, 'Atlas current'); emit(first);
  await vi.waitFor(() => expect(hooks.onAgent).toHaveBeenCalledTimes(1));
  expect((await buildPanelState(7)).researchDetails?.attempts[0]?.action.query).toBe('Atlas current');
  expect(JSON.stringify(await buildPanelState(7))).not.toMatch(/PRIVATE_SOURCE_BODY|answerPolicy|researchCheckpoint/);
  release(); await running;
  const resumed = resume();
  await vi.waitFor(() => expect(storage.research).toHaveBeenCalledTimes(2));
  const next = publish(2, 'Atlas clarified'); emit(next); emit(first);
  emit({ ...next, seq: 3, identity: { ...next.identity, fingerprint: 'obsolete' } });
  await vi.waitFor(() => expect(hooks.onAgent).toHaveBeenCalledTimes(2));
  expect((await buildPanelState(7)).researchDetails?.attempts[0]?.action.query).toBe('Atlas clarified');
  abortRun(7); await recoverInterruptedRun(7);
  emit({ ...next, seq: 4 }); release(); await resumed;
  expect(hooks.onAgent).toHaveBeenCalledTimes(2);
  expect((await buildPanelState(7)).researchDetails).toBeUndefined();
});

it('publishes the running identity before executing initial and resumed research', async () => {
  let deliver!: () => void;
  let published = false;
  const registration = vi.fn();
  const stateHook = vi.fn(async () => {
    const state = await storage.get();
    if (state?.researchPending?.status !== 'running') return;
    registration(state.researchPending.runId);
    await new Promise<void>(resolve => { deliver = resolve; });
    published = true;
  });
  storage.research.mockImplementation(async checkpoint => {
    expect(published).toBe(true);
    return waiting(checkpoint);
  });
  const first = handleIntent({ kind: 'ask', tabId: 7, question: '查证这一结论', network: 'force' }, { ...hooks, onState: stateHook });
  await vi.waitFor(() => expect(registration).toHaveBeenCalledTimes(1));
  expect(storage.research).not.toHaveBeenCalled();
  deliver(); await first;
  const state = (await storage.get())!; published = false;
  const continued = handleIntent({ kind: 'resolveResearch', tabId: 7, sessionId: state.id, runId: state.run!.id, mode: 'continue', text: 'Atlas' }, { ...hooks, onState: stateHook });
  await vi.waitFor(() => expect(registration).toHaveBeenCalledTimes(2));
  expect(storage.research).toHaveBeenCalledTimes(1);
  deliver(); await continued;
  expect(storage.research).toHaveBeenCalledTimes(2);
});

it.each([false, true])('stop during delayed identity publication prevents initial/resumed execution (resume: %s)', async continued => {
  if (continued) { storage.research.mockImplementationOnce(async checkpoint => waiting(checkpoint)); await ask(); }
  let deliver!: () => void;
  let publishing = false;
  const stateHook = async () => {
    if ((await storage.get())?.researchPending?.status !== 'running') return;
    publishing = true;
    await new Promise<void>(resolve => { deliver = resolve; });
  };
  const before = storage.research.mock.calls.length;
  const session = (await storage.get())!;
  const running = handleIntent(continued
    ? { kind: 'resolveResearch', tabId: 7, sessionId: session.id, runId: session.run!.id, mode: 'continue', text: 'Atlas' }
    : { kind: 'ask', tabId: 7, question: '查证这一结论', network: 'force' }, { ...hooks, onState: stateHook });
  await vi.waitFor(() => expect(publishing).toBe(true));
  abortRun(7); deliver(); await running;
  expect(storage.research).toHaveBeenCalledTimes(before);
  expect((await storage.get())?.researchPending?.status).toBe('stopped');
  expect((await storage.get())?.run).toBeNull();
  expect(hooks.onAgent).not.toHaveBeenCalled();
});

it('cleans up a resumed run if publishing its running identity fails', async () => {
  storage.research.mockImplementationOnce(async checkpoint => waiting(checkpoint)); await ask();
  const state = (await storage.get())!;
  const onState = async () => {
    if ((await storage.get())?.researchPending?.status === 'running') throw new Error('State publication failed');
  };
  await expect(handleIntent({ kind: 'resolveResearch', tabId: 7, sessionId: state.id, runId: state.run!.id,
    mode: 'continue', text: 'Atlas' }, { ...hooks, onState })).resolves.toBeTruthy();
  expect((await storage.get())?.run).toBeNull();
  expect((await storage.get())?.researchPending?.status).toBe('interrupted');
  expect(storage.research).toHaveBeenCalledTimes(1);
});
