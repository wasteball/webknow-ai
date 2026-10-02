import { beforeEach, describe, expect, it, vi } from 'vitest';
const data = new Map<string, unknown>();
vi.mock('wxt/utils/storage', () => ({ storage: {
  getItem: vi.fn(async (key: string) => structuredClone(data.get(key))),
  setItem: vi.fn(async (key: string, value: unknown) => { data.set(key, structuredClone(value)); }),
  snapshot: async (area: string) => Object.fromEntries([...data].filter(([key]) => key.startsWith(area + ':')).map(([key, value]) => [key.slice(area.length + 1), value])),
  removeItems: async (keys: string[]) => keys.forEach(key => data.delete(key)),
} }));
import { storage } from 'wxt/utils/storage';
import { readConfig, saveSearchAgentSettings, hasOutboundConfirmation, deleteApiKey, clearAllSessions, saveSearchConfig, applySettings, writeConfig, saveApiKey } from '../src/background/store';
import { outboundScope } from '../src/core/settings';
import { effectiveAgentSettings, runtimeAgentSettings } from '../src/core/search/agent-policy';
import { DEFAULT_SEARCH_AGENT_POLICY } from '../src/core/prompts/search-agent';
beforeEach(() => { data.clear(); vi.mocked(storage.setItem).mockReset().mockImplementation(async (key, value) => { data.set(key, structuredClone(value)); }); });
it('keeps legacy credentials and defaults off with the unique effective policy', async () => {
  data.set('local:config', { search: { providerId: 'tavily', credentials: { tavily: { apiKey: 'secret' } } } });
  expect(effectiveAgentSettings(await readConfig())).toMatchObject({ enabled: false, policy: DEFAULT_SEARCH_AGENT_POLICY });
  await saveSearchAgentSettings({ depth: 'quick' });
  expect((await readConfig()).search?.credentials?.tavily?.apiKey).toBe('secret');
});
it('merges only valid supplied preferences and empty policy restores only policy', async () => {
  data.set('local:config', { apiKeys: { deepseek: 'secret' }, prompts: { answer: 'answer' }, search: { agent: { enabled: true, policy: 'saved' } } });
  await saveSearchAgentSettings({ policy: 'x'.repeat(8001), preferredDomains: ['A.com', 'a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'] });
  expect((await readConfig()).search?.agent).toMatchObject({ enabled: true, policy: 'saved', preferredDomains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'] });
  await saveSearchAgentSettings({ policy: 'bad\u0000' });
  expect((await readConfig()).search?.agent?.policy).toBe('saved');
  await saveSearchAgentSettings({ policy: '' });
  expect((await readConfig()).search?.agent?.policy).toBeUndefined();
  expect(await readConfig()).toMatchObject({ apiKeys: { deepseek: 'secret' }, prompts: { answer: 'answer' } });
});
it('confirmation covers receivers and declared scope but never keys or policy', () => {
  const config = { provider: 'deepseek' as const, search: { providerId: 'searxng', credentials: { searxng: { baseUrl: 'https://one.example/path', apiKey: 'secret' } } } };
  const scope = outboundScope(config);
  expect(scope).not.toContain('secret');
  expect(scope).toContain('https://one.example');
  const changedKey = { ...config, apiKeys: { deepseek: 'changed' }, search: { ...config.search, agent: { policy: 'new' } } };
  expect(outboundScope(changedKey)).toBe(scope);
  const accepted = { ...config, outbound: { version: '2026-10-01.1', acceptedAt: 1, receiver: 'DeepSeek（深度求索）', scope } };
  expect(hasOutboundConfirmation(accepted)).toBe(true);
  expect(hasOutboundConfirmation({ ...accepted, outbound: { ...accepted.outbound, version: '2026-09-19.2' } })).toBe(false);
  expect(hasOutboundConfirmation({ ...accepted, search: { ...accepted.search, credentials: { searxng: { baseUrl: 'https://two.example' } } } })).toBe(false);
  expect(hasOutboundConfirmation({ ...accepted, search: { ...accepted.search, agent: { sourceReading: 'off' } } })).toBe(false);
});
it('resolves empty locale sentinels while retaining explicit preferences', () => {
  expect(runtimeAgentSettings({}, 'zh-Hant-TW')).toMatchObject({ language: 'zh-Hant-TW', region: 'TW' });
  expect(runtimeAgentSettings({}, 'en')).toMatchObject({ language: 'en', region: '' });
  expect(runtimeAgentSettings({ search: { agent: { language: 'fr', region: 'CA' } } }, 'en-US')).toMatchObject({ language: 'fr', region: 'CA' });
  expect(effectiveAgentSettings({})).toMatchObject({ language: '', region: '' });
});

it('policy restore, key deletion and session clearing remain independent', async () => {
  data.set('local:config', { apiKeys: { deepseek: 'model-private' }, search: { providerId: 'tavily', credentials: { tavily: { apiKey: 'search-private' } }, agent: { enabled: true, policy: 'custom', depth: 'quick' } }, prompts: { answer: 'answer policy' } });
  data.set('session:sess:7', { chat: ['conversation'] });
  await saveSearchAgentSettings({ policy: '' });
  expect(data.get('session:sess:7')).toEqual({ chat: ['conversation'] });
  expect((await readConfig()).apiKeys?.deepseek).toBe('model-private');
  await deleteApiKey('deepseek');
  expect((await readConfig()).search?.agent).toEqual({ enabled: true, depth: 'quick' });
  expect(data.has('session:sess:7')).toBe(true);
  expect(await clearAllSessions()).toBe(1);
  expect((await readConfig()).search?.credentials?.tavily?.apiKey).toBe('search-private');
  expect((await readConfig()).prompts?.answer).toBe('answer policy');
});


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Hold the first physical write while another accepted operation is requested. */
function holdFirstWrite() {
  const started = deferred(); const release = deferred();
  vi.mocked(storage.setItem).mockImplementationOnce(async (key, value) => {
    started.resolve(); await release.promise; data.set(key, structuredClone(value));
  });
  return { started: started.promise, release: release.resolve };
}

describe('shared configuration transactions', () => {
  it('preserves independent language and region patches through delayed overlapping writes', async () => {
    data.set('local:config', { search: { agent: { enabled: true, language: '', region: '' } } });
    const held = holdFirstWrite();
    const language = saveSearchAgentSettings({ language: 'fr' }); await held.started;
    const region = saveSearchAgentSettings({ region: 'CA' });
    await Promise.resolve(); held.release(); await Promise.all([language, region]);
    expect((await readConfig()).search?.agent).toMatchObject({ enabled: true, language: 'fr', region: 'CA' });
  });
  it.each([
    ['search provider', () => saveSearchConfig({ providerId: 'tavily', credentials: { apiKey: 'search-private' } }), { search: { providerId: 'tavily', credentials: { tavily: { apiKey: 'search-private' } } } }],
    ['model provider', () => applySettings({ provider: 'zhipu' }), { provider: 'zhipu' }],
    ['general configuration', () => writeConfig({ diagrams: 'off' }), { diagrams: 'off' }],
    ['model key', () => saveApiKey('zhipu', 'new-private'), { apiKeys: { zhipu: 'new-private' } }],
  ] as const)('preserves accepted agent preference during overlapping %s save', async (_name, saveOther, expected) => {
    data.set('local:config', { apiKeys: { deepseek: 'model-private' }, search: { agent: { enabled: true } } });
    const held = holdFirstWrite();
    const agent = saveSearchAgentSettings({ language: 'fr' }); await held.started;
    const other = saveOther(); await Promise.resolve(); held.release(); await Promise.all([agent, other]);
    const config = await readConfig();
    expect(config.search?.agent).toMatchObject({ enabled: true, language: 'fr' });
    expect(config).toMatchObject(expected);
    expect(config.apiKeys?.deepseek).toBe('model-private');
  });
  it('serializes migration writes with a concurrently requested preference save', async () => {
    data.set('local:config', { apiKey: 'legacy-private', model: 'legacy-model' });
    const held = holdFirstWrite();
    const migration = readConfig(); await held.started;
    const preference = saveSearchAgentSettings({ region: 'CA' });
    await Promise.resolve(); held.release(); await Promise.all([migration, preference]);
    expect(await readConfig()).toMatchObject({ apiKeys: { deepseek: 'legacy-private' }, models: { deepseek: 'legacy-model' }, search: { agent: { region: 'CA' } } });
    expect(await readConfig()).not.toHaveProperty('apiKey');
  });
  it('rejects a failed queued save while later queued patches still succeed', async () => {
    data.set('local:config', { search: { agent: { enabled: true } } });
    const held = deferred(); const started = deferred();
    vi.mocked(storage.setItem).mockImplementationOnce(async () => { started.resolve(); await held.promise; throw new Error('write failed'); });
    const failed = saveSearchAgentSettings({ language: 'fr' });
    const rejection = expect(failed).rejects.toThrow('write failed'); await started.promise;
    const accepted = saveSearchAgentSettings({ region: 'CA' }); held.resolve();
    await Promise.all([rejection, accepted]);
    expect((await readConfig()).search?.agent).toMatchObject({ enabled: true, region: 'CA' });
    expect((await readConfig()).search?.agent?.language).toBeUndefined();
    await saveSearchAgentSettings({ depth: 'quick' });
    expect((await readConfig()).search?.agent?.depth).toBe('quick');
  });
});
