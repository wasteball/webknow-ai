import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => {
  const ports: ReturnType<typeof makePort>[] = [];
  function makePort() {
    const messages: ((message: unknown) => void)[] = [];
    const disconnects: (() => void)[] = [];
    return {
      postMessage: vi.fn(),
      onMessage: { addListener: (fn: (message: unknown) => void) => messages.push(fn) },
      onDisconnect: { addListener: (fn: () => void) => disconnects.push(fn) },
      emit: (message: unknown) => messages.forEach((fn) => fn(message)),
      disconnect: () => disconnects.forEach((fn) => fn()),
    };
  }
  return { ports, connect: vi.fn(() => { const port = makePort(); ports.push(port); return port; }) };
});
vi.mock('wxt/browser', () => ({ browser: { runtime: { connect: transport.connect } } }));

import { createClient, type Client } from '../src/sidepanel/api';
import { panel } from './helpers/panel';
import { snapshotFixture } from './helpers/research';

let client: Client;
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); transport.ports.length = 0; });
afterEach(() => { client?.dispose(); vi.useRealTimers(); });

function reply(port: typeof transport.ports[number], index = 0) {
  const { id } = port.postMessage.mock.calls[index]![0];
  port.emit({ type: 'reply', id, reply: { ok: true } });
}

describe('panel reconnect', () => {
  it('restores the current page subscription and receives its state after reconnect', async () => {
    const onState = vi.fn();
    client = createClient({ onState, onProgress: vi.fn() });
    const attaching = client.send({ type: 'attach', tabId: 7 });
    reply(transport.ports[0]!);
    await attaching;
    transport.ports[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(250);
    const restored = transport.ports[1]!;
    expect(restored.postMessage.mock.calls.map(([message]) => message.command)).toContainEqual({ type: 'attach', tabId: 7 });
    restored.emit({ type: 'state', state: { tabId: 7, busy: null, chat: [{ answer: '已回答' }] } });
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7, chat: [{ answer: '已回答' }] }));
  });

  it('uses a tab changed during disconnection, not the previous page', async () => {
    const onState = vi.fn();
    client = createClient({ onState, onProgress: vi.fn() });
    const first = client.send({ type: 'attach', tabId: 7 });
    reply(transport.ports[0]!);
    await first;
    transport.ports[0]!.disconnect();
    await client.send({ type: 'attach', tabId: 9 });
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.ports[1]!.postMessage.mock.calls.map(([message]) => message.command)).toContainEqual({ type: 'attach', tabId: 9 });
    transport.ports[0]!.emit({ type: 'state', state: { tabId: 7 } });
    expect(onState).not.toHaveBeenCalled();
  });

  it('restores settings attachment without replaying a paid request', async () => {
    client = createClient({ onState: vi.fn(), onProgress: vi.fn() });
    const attaching = client.send({ type: 'attach', tabId: null });
    reply(transport.ports[0]!);
    await attaching;
    const asking = client.send({ type: 'ask', tabId: 7, question: '为什么？' });
    transport.ports[0]!.disconnect();
    expect((await asking).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.ports[1]!.postMessage.mock.calls.map(([message]) => message.command)).toEqual([{ type: 'attach', tabId: null }]);
    client.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.ports).toHaveLength(2);
  });
});

it('reconnects after a clarification command without replaying its same-run continuation', async () => {
  client = createClient({ onState: vi.fn(), onProgress: vi.fn() });
  const attaching = client.send({ type: 'attach', tabId: 7 }); reply(transport.ports[0]!); await attaching;
  const resuming = client.send({ type: 'resolveResearch', tabId: 7, sessionId: 's1', runId: 'r1', mode: 'continue', text: '产品 A' });
  transport.ports[0]!.disconnect(); expect((await resuming).ok).toBe(false);
  await vi.advanceTimersByTimeAsync(250);
  expect(transport.ports[1]!.postMessage.mock.calls.map(([message]) => message.command)).toEqual([{ type: 'attach', tabId: 7 }]);
});

it('accepts only current research identity and increasing event sequence and hides research draft progress', async () => {
  const onAgent = vi.fn();
  const onProgress = vi.fn();
  const onState = vi.fn();
  client = createClient({ onState, onProgress, onAgent });
  const attaching = client.send({ type: 'attach', tabId: 7 }); reply(transport.ports[0]!); await attaching;
  const port = transport.ports[0]!;
  const identity = snapshotFixture().identity;
  const event = { identity, seq: 2, phase: 'searching' as const, searches: 1, reads: 0, reason: 'initial' as const };
  const state = panel({ sessionId: 's1', pageUrl: identity.url, researchPending: { runId: 'r1', question: '最新版本', quote: null, status: 'running' },
    busy: { kind: 'answer', chars: 0, draft: '', reasoning: '', agent: { ...event, seq: 1 } } });
  port.emit({ type: 'state', state });
  port.emit({ type: 'agent', event });
  expect(onAgent).toHaveBeenCalledOnce();
  port.emit({ type: 'agent', event });
  port.emit({ type: 'agent', event: { ...event, seq: 1 } });
  for (const identityChange of [{ runId: 'old' }, { sessionId: 'old' }, { tabId: 9 }, { fingerprint: 'old' }, { url: 'https://example.org/old' }, { modelId: 'old' }, { modelProvider: 'zhipu' }]) {
    port.emit({ type: 'agent', event: { ...event, identity: { ...identity, ...identityChange }, seq: 3 } });
  }
  expect(onAgent).toHaveBeenCalledOnce();
  port.emit({ type: 'progress', chars: 50, draft: 'raw JSON', reasoning: 'private' });
  expect(onProgress).not.toHaveBeenCalled();
  port.emit({ type: 'state', state: { ...state, busy: null, researchPending: { ...state.researchPending!, status: 'interrupted' } } });
  port.emit({ type: 'agent', event: { ...event, seq: 4 } });
  expect(onAgent).toHaveBeenCalledOnce();
});

it('retains monotonic agent progress across a same-run state refresh without an event snapshot', async () => {
  const onState = vi.fn();
  const onAgent = vi.fn();
  client = createClient({ onState, onAgent, onProgress: vi.fn() });
  const attaching = client.send({ type: 'attach', tabId: 7 }); reply(transport.ports[0]!); await attaching;
  const port = transport.ports[0]!;
  const identity = snapshotFixture().identity;
  const details = { sources: [], attempts: [], conflicts: [], freshness: 'not_applicable' as const, degraded: false };
  const event = { details, identity, seq: 5, phase: 'reading' as const, searches: 2, reads: 1, reason: 'initial' as const };
  const state = panel({ sessionId: 's1', pageUrl: identity.url, researchPending: { runId: 'r1', question: '最新版本', quote: null, status: 'running' },
    busy: { kind: 'answer', chars: 0, draft: '', reasoning: '', agent: event } });
  port.emit({ type: 'state', state });
  port.emit({ type: 'state', state: { ...state, busy: { kind: 'answer', chars: 0, draft: '', reasoning: '' } } });
  expect(onState.mock.lastCall?.[0].busy.agent?.seq).toBe(5);
  expect(onState.mock.lastCall?.[0].researchDetails).toEqual(details);
  port.emit({ type: 'agent', event: { ...event, seq: 4 } });
  expect(onAgent).not.toHaveBeenCalled();
});

it('rejects a first research event from the wrong page or receiver even without an event snapshot', async () => {
  const onAgent = vi.fn();
  client = createClient({ onState: vi.fn(), onProgress: vi.fn(), onAgent });
  const attaching = client.send({ type: 'attach', tabId: 7 }); reply(transport.ports[0]!); await attaching;
  const port = transport.ports[0]!;
  const identity = snapshotFixture().identity;
  const state = panel({ sessionId: 's1', pageUrl: identity.url, researchPending: { runId: 'r1', question: '最新版本', quote: null, status: 'running' }, busy: { kind: 'answer', chars: 0, draft: '', reasoning: '' } });
  port.emit({ type: 'state', state });
  const event = { identity, seq: 1, phase: 'deciding' as const, searches: 0, reads: 0, reason: 'initial' as const };
  port.emit({ type: 'agent', event: { ...event, identity: { ...identity, url: 'https://other.org/old' } } });
  port.emit({ type: 'agent', event: { ...event, identity: { ...identity, modelProvider: 'zhipu' } } });
  expect(onAgent).not.toHaveBeenCalled();
  port.emit({ type: 'agent', event });
  expect(onAgent).toHaveBeenCalledWith(event);
});
