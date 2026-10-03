import { beforeEach, describe, expect, it, vi } from 'vitest';

const data = new Map<string, unknown>();
const network = vi.hoisted(() => ({
  chatJson: vi.fn(async () => ({ ok: true })),
  chatVision: vi.fn(async () => '读图结果'),
}));

vi.mock('wxt/utils/storage', () => ({
  storage: {
    getItem: vi.fn(async (key: string) => data.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => void data.set(key, value)),
  },
}));
vi.mock('../src/core/model-call', () => network);
vi.mock('wxt/browser', () => ({
  browser: { tabs: { get: vi.fn(async () => ({ url: 'https://example.com/article' })) } },
}));
vi.mock('../src/background/ima', () => ({ hasImaCredentials: vi.fn(async () => false) }));

import { outboundScope, OUTBOUND_NOTICE_VERSION } from '../src/core/settings';
import { callModel, readImage } from '../src/background/model';
import { buildPanelState } from '../src/background/router';
import { applySettings, readConfig } from '../src/background/store';

const deepseekConsent = {
  version: OUTBOUND_NOTICE_VERSION,
  scope: outboundScope({}),
  receiver: 'DeepSeek（深度求索）',
  acceptedAt: 1,
};

describe('模型正文外发确认', () => {
  beforeEach(() => {
    data.clear();
    vi.clearAllMocks();
  });

  it('切换供应商会使旧确认失效，切回原供应商也要重新确认', async () => {
    data.set('local:config', { provider: 'deepseek', outbound: deepseekConsent });

    await applySettings({ provider: 'zhipu' });
    expect((await readConfig()).outbound).toBeUndefined();
    await applySettings({ provider: 'deepseek' });
    expect((await readConfig()).outbound).toBeUndefined();
  });

  it('即使旧会话还能发指令，模型出口也拒绝把正文发给未确认的接收方', async () => {
    data.set('local:config', {
      provider: 'zhipu',
      apiKeys: { zhipu: 'zhipu-key' },
      outbound: deepseekConsent,
    });

    await expect(callModel([{ role: 'user', content: '来自文章的内容' }], new AbortController().signal, () => {}))
      .rejects.toMatchObject({ code: 'OUTBOUND_CONFIRMATION_REQUIRED' });
    expect(network.chatJson).not.toHaveBeenCalled();
  });

  it('内容图同样不能绕过外发确认', async () => {
    data.set('local:config', {
      provider: 'deepseek',
      apiKeys: { deepseek: 'deepseek-key' },
      outbound: { ...deepseekConsent, receiver: '智谱（Zhipu）' },
    });

    await expect(readImage('data:image/jpeg;base64,AAAA', new AbortController().signal))
      .rejects.toMatchObject({ code: 'OUTBOUND_CONFIRMATION_REQUIRED' });
    expect(network.chatVision).not.toHaveBeenCalled();
  });

  it('已有结果的侧栏在切换供应商后显示新的确认入口', async () => {
    data.set('local:config', {
      provider: 'deepseek',
      apiKeys: { deepseek: 'deepseek-key', zhipu: 'zhipu-key' },
      outbound: deepseekConsent,
    });
    data.set('session:sess:42', {
      tabId: 42,
      url: 'https://example.com/article',
      title: '示例文章',
      state: 'READY',
      run: null,
      error: null,
    });

    await applySettings({ provider: 'zhipu' });
    const state = await buildPanelState(42);

    expect(state.settings.provider).toBe('zhipu');
    expect(state.outboundConfirmed).toBe(false);
    expect(state.phase).toBe('READY_TO_START');
  });
});

it('stores fresh scope confirmation and exposes product defaults and declared receivers', async () => {
  data.set('local:config', { provider: 'deepseek', apiKeys: { deepseek: 'MODEL_PRIVATE_VALUE' },
    search: { providerId: 'searxng', credentials: { searxng: { baseUrl: 'https://instance.example/search', apiKey: 'SEARCH_PRIVATE_VALUE' } }, agent: { policy: 'visible editable policy' } } });
  const { registerPanelPort } = await import('../src/background/router');
  let receive!: (message: unknown) => void;
  const postMessage = vi.fn();
  registerPanelPort({ onMessage: { addListener: listener => { receive = listener; } }, onDisconnect: { addListener: vi.fn() }, postMessage });
  receive({ id: 42, command: { type: 'confirmOutbound' } });
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'reply', id: 42, reply: { ok: true } }));
  const panel = await buildPanelState(null);
  expect(panel.outboundConfirmed).toBe(true);
  expect(panel.settings.search.enabled).toBe(true);
  expect(panel.settings.search.agent.enabled).toBe(false);
  expect(panel.settings.search.agent.policy).not.toBe('visible editable policy');
  expect((await readConfig()).search?.agent?.policy).toBe('visible editable policy');
  expect(panel.settings.search.receiver).toContain('https://instance.example');
  expect(panel.settings.search.sourceCapabilities.directRead).toBe(false);
  expect(JSON.stringify(panel)).not.toContain('MODEL_PRIVATE_VALUE');
  expect(JSON.stringify(panel)).not.toContain('SEARCH_PRIVATE_VALUE');
  expect((await readConfig()).outbound?.version).toBe(OUTBOUND_NOTICE_VERSION);
});
