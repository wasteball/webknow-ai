import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  approval: vi.fn(),
  credentials: vi.fn(),
  saveCapability: vi.fn(),
}));

vi.mock('../src/model-secret', () => ({
  modelApprovalState: mocks.approval,
  modelCredentials: mocks.credentials,
}));
vi.mock('../src/storage', () => ({ saveModelCapability: mocks.saveCapability }));

import { approvedModelCredentials, chatJson } from '../src/model';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('model channel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.approval.mockReset();
    mocks.credentials
      .mockReset()
      .mockResolvedValue({ configId: 'config-1', model: 'deepseek-chat', apiKey: 'test-secret' });
  });

  it.each([
    [401, { error: { message: 'unauthorized' } }, 'AUTH'],
    [404, { error: { message: 'model not found' } }, 'MODEL_NOT_FOUND'],
    [429, { error: { message: 'rate limit' } }, 'RATE_LIMITED'],
    [402, { error: { message: 'insufficient balance' } }, 'BALANCE_INSUFFICIENT'],
    [503, { error: { message: 'unavailable' } }, 'NETWORK'],
  ])('normalizes HTTP %s without exposing provider bodies', async (status, body, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status as number, body)));
    await expect(chatJson({ messages: [{ role: 'user', content: 'test' }] })).rejects.toMatchObject(
      { detail: { code } },
    );
  });

  it('parses only JSON object content from chat completions', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(response(200, { choices: [{ message: { content: '{"ok":true}' } }] })),
    );
    await expect(chatJson({ messages: [{ role: 'user', content: 'test' }] })).resolves.toEqual({
      ok: true,
    });
  });

  it('maps caller cancellation without leaking the API key', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            if (init.signal?.aborted) {
              reject(new DOMException('Aborted', 'AbortError'));
              return;
            }
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    const pending = chatJson({
      messages: [{ role: 'user', content: 'test' }],
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ detail: { code: 'CANCELLED' } });
    try {
      await pending;
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('test-secret');
    }
  });
  it('requires the same config to be tested and recipient-confirmed', async () => {
    const credentials = { configId: 'config-1', model: 'deepseek-chat', apiKey: 'test-secret' };
    mocks.approval.mockResolvedValue({ credentials, tested: false, confirmed: true });
    await expect(approvedModelCredentials()).rejects.toMatchObject({
      detail: { code: 'NOT_CONFIGURED' },
    });
    mocks.approval.mockResolvedValue({ credentials, tested: true, confirmed: false });
    await expect(approvedModelCredentials()).rejects.toMatchObject({
      detail: { code: 'PERMISSION_REQUIRED' },
    });
    mocks.approval.mockResolvedValue({ credentials, tested: true, confirmed: true });
    await expect(approvedModelCredentials()).resolves.toEqual(credentials);
  });
});
