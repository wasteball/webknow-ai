import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PageSession } from '../src/core/session';
import type { Config } from '../src/background/store';
import type { AgentCheckpoint, AgentEvent, AgentOutcome } from '../src/core/search/agent-types';

const storage = vi.hoisted(() => {
  let session: PageSession | null = null;
  return {
    get: vi.fn(async () => session ? structuredClone(session) : null),
    put: vi.fn(async (next: PageSession) => { session = structuredClone(next); }),
    config: vi.fn<() => Promise<Config>>(), model: vi.fn(), research: vi.fn(), ima: vi.fn(async () => false),
  };
});
vi.mock('../src/background/store', () => ({ getSession: storage.get, putSession: storage.put,
  readConfig: storage.config, hasOutboundConfirmation: () => true, getPending: vi.fn(async () => null) }));
vi.mock('../src/background/model', () => ({ callModel: vi.fn(), callResearchModel: storage.model, assertOutboundConfirmation: vi.fn() }));
vi.mock('../src/background/research', async original => ({
  ...await original<Record<string, unknown>>(), executeResearch: storage.research,
}));
vi.mock('../src/background/page', () => ({
  readPageIdentity: vi.fn(async () => ({ url: 'https://example.com/article', fingerprint: 'fp' })),
  toAppError: (error: unknown) => error,
}));
vi.mock('../src/background/ima', () => ({ hasImaCredentials: storage.ima }));
vi.mock('wxt/browser', () => ({ browser: { tabs: { get: vi.fn(async () => ({ url: 'https://example.com/article' })) },
  permissions: { contains: vi.fn(async () => true) } } }));

import { emptySession } from '../src/core/session';
import { abortRun, handleIntent, recoverInterruptedRun } from '../src/background/runner';
import { notifyTab, registerPanelPort } from '../src/background/router';

import type { Event } from '../src/core/protocol';

function waiting(checkpoint: AgentCheckpoint): AgentOutcome {
  const question = { type: 'ask_user' as const, question: 'Which version?', reason: 'ambiguous_entity' as const };
  return { kind: 'waiting', checkpoint: { ...checkpoint, waiting: question }, question };
}
const idleTurn = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(async () => {
  vi.clearAllMocks();
  storage.ima.mockReset().mockResolvedValue(false);
  storage.research.mockReset().mockImplementation(async checkpoint => waiting(checkpoint));
  storage.config.mockResolvedValue({ provider: 'deepseek', search: { providerId: 'firecrawl', agent: { enabled: true } } });
  await storage.put({ ...emptySession(7, 'https://example.com/article'), state: 'READY', fingerprint: 'fp',
    blocks: [{ id: 'b_0', role: 'paragraph', content: 'Three teams.', headingPath: [],
      anchor: { sessionAnchorId: 'a0', selector: 'p', exact: 'Three teams.', prefix: '', suffix: '', headingPath: [], fingerprint: 'fp' } }],
    guide: { summary: 'Three teams.', bubbles: [] } });
});
afterEach(async () => {
  abortRun(7); await recoverInterruptedRun(7);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function start(continued: boolean) {
  const messages: Event[] = [];
  let receive!: (value: unknown) => void;
  let disconnect!: () => void;
  registerPanelPort({ postMessage: message => messages.push(message),
    onMessage: { addListener: cb => { receive = cb; } }, onDisconnect: { addListener: cb => { disconnect = cb; } } });
  receive({ id: 1, command: { type: 'attach', tabId: 7 } });
  await vi.waitFor(() => expect(messages.some(m => m.type === 'reply')).toBe(true));
  const hooks = { onState: notifyTab, onProgress: vi.fn(), onAgent: (_tabId: number, event: AgentEvent) => messages.push({ type: 'agent', event }) };
  const ask = { kind: 'ask' as const, tabId: 7, question: 'Check this claim', search: true };
  if (continued) {
    await handleIntent(ask, hooks);
    await idleTurn();
  }
  messages.length = 0;
  storage.research.mockClear();
  const builds: { resolve: (value: boolean) => void; reject: (error: Error) => void }[] = [];
  storage.ima.mockImplementation(async () => {
    if ((await storage.get())?.researchPending?.status !== 'running') return false;
    return new Promise<boolean>((resolve, reject) => builds.push({ resolve, reject }));
  });
  const session = (await storage.get())!;
  const running = handleIntent(continued
    ? { kind: 'resolveResearch', tabId: 7, sessionId: session.id, runId: session.run!.id, mode: 'continue', text: 'Atlas' }
    : ask, hooks);
  await vi.waitFor(() => expect(builds).toHaveLength(1));
  const replacements: Promise<void>[] = [];
  return { messages, builds, running,
    replace: async () => {
      const count = builds.length;
      const next = notifyTab(7);
      // Observe rejection immediately, even if the test has not reached its assertion yet.
      void next.catch(() => {});
      replacements.push(next);
      await vi.waitFor(() => expect(builds).toHaveLength(count + 1));
      return { next };
    },
    cleanup: async () => {
      storage.ima.mockResolvedValue(false);
      builds.forEach(build => build.resolve(false));
      abortRun(7);
      await Promise.allSettled([running, ...replacements]);
      await idleTurn(); disconnect();
    },
  };
}

it.each([false, true])('waits through repeated router replacements before the first guarded event (resume: %s)', async continued => {
  const test = await start(continued);
  let finish!: () => void;
  storage.research.mockImplementation((checkpoint: AgentCheckpoint, _signal: AbortSignal, emit: (event: AgentEvent) => void) => {
    emit({ identity: checkpoint.snapshot.identity, seq: 1, phase: 'deciding', searches: 0, reads: 0, reason: 'initial' });
    return new Promise(resolve => { finish = () => resolve(waiting(checkpoint)); });
  });
  try {
    await test.replace();
    test.builds[0]!.resolve(false);
    await idleTurn();
    expect(storage.research).not.toHaveBeenCalled();
    // Replace again after the original caller has started waiting on its successor.
    await test.replace();
    test.builds[1]!.resolve(false);
    await idleTurn();
    expect(storage.research).not.toHaveBeenCalled();
    expect(test.messages.some(m => m.type === 'state')).toBe(false);
    test.builds[2]!.resolve(false);
    await vi.waitFor(() => expect(test.messages.some(m => m.type === 'agent')).toBe(true));
    const firstAgent = test.messages.findIndex(m => m.type === 'agent');
    const states = test.messages.slice(0, firstAgent).filter(m => m.type === 'state');
    expect(states).toHaveLength(1);
    expect(states[0]?.state.researchPending?.status).toBe('running');
    const event = test.messages.find(m => m.type === 'agent')!;
    expect(states[0]?.state.researchPending?.runId).toBe(event.event.identity.runId);
    finish(); await test.running;
  } finally { finish?.(); await test.cleanup(); }
});

it.each([false, true])('stop during a successor publication prevents execution (resume: %s)', async continued => {
  const test = await start(continued);
  try {
    await test.replace();
    test.builds[0]!.resolve(false); await idleTurn();
    abortRun(7);
    test.builds[1]!.resolve(false); await test.running;
    expect(storage.research).not.toHaveBeenCalled();
    expect((await storage.get())?.researchPending?.status).toBe('stopped');
    expect((await storage.get())?.run).toBeNull();
    expect(test.messages.some(m => m.type === 'agent')).toBe(false);
  } finally { await test.cleanup(); }
});

it.each([false, true])('failed authoritative publication cleans up all waiting callers (resume: %s)', async continued => {
  const test = await start(continued);
  try {
    const { next } = await test.replace();
    test.builds[0]!.resolve(false); await idleTurn();
    test.builds[1]!.reject(new Error('Publication unavailable'));
    await expect(next).rejects.toThrow('Publication unavailable');
    expect(await test.running).toBeTruthy();
    expect(storage.research).not.toHaveBeenCalled();
    expect((await storage.get())?.run).toBeNull();
    expect((await storage.get())?.researchCheckpoint).toBeUndefined();
    expect((await storage.get())?.researchPending?.status).toBe('interrupted');
    await notifyTab(7);
    expect(test.messages.filter(m => m.type === 'state').at(-1)?.state.researchPending?.status).toBe('interrupted');
  } finally { await test.cleanup(); }
});

it('a failed superseded build follows its successor instead of failing the run', async () => {
  const test = await start(false);
  try {
    await test.replace();
    test.builds[0]!.reject(new Error('Obsolete build failed')); await idleTurn();
    expect(storage.research).not.toHaveBeenCalled();
    test.builds[1]!.resolve(false);
    expect(await test.running).toBeNull();
    expect((await storage.get())?.researchPending?.status).toBe('waiting');
  } finally { await test.cleanup(); }
});

it.each(['expiry', 'page change'] as const)('preserves the real research guard after successor wait: %s', async change => {
  const test = await start(true);
  const actual = await vi.importActual<typeof import('../src/background/research')>('../src/background/research');
  storage.research.mockImplementation(actual.executeResearch);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  try {
    await test.replace();
    test.builds[0]!.resolve(false); await idleTurn();
    expect(storage.research).not.toHaveBeenCalled();
    const session = (await storage.get())!;
    const deadline = session.researchCheckpoint!.deadlineAt;
    if (change === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    else await storage.put({ ...session, fingerprint: 'changed' });
    test.builds[1]!.resolve(false); await test.running;
    expect(storage.model).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect((await storage.get())?.chat).toHaveLength(0);
    expect((await storage.get())?.run).toBeNull();
    expect((await storage.get())?.researchPending?.status).toBe('interrupted');
    expect(test.messages.some(m => m.type === 'agent')).toBe(false);
  } finally { await test.cleanup(); }
});

it('ignores an old completion after its successor has already published', async () => {
  const test = await start(false);
  try {
    const { next } = await test.replace();
    test.builds[1]!.resolve(false); await next;
    expect(test.messages.filter(m => m.type === 'state')).toHaveLength(1);
    test.builds[0]!.resolve(false); await test.running; await idleTurn();
    const states = test.messages.filter(m => m.type === 'state');
    expect(states.filter(m => m.state.researchPending?.status === 'running')).toHaveLength(1);
    expect(states.at(-1)?.state.researchPending?.status).toBe('waiting');
  } finally { await test.cleanup(); }
});
