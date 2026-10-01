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
