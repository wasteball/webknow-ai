import { beforeEach, describe, expect, it, vi } from 'vitest';
const data = new Map<string, unknown>();
vi.mock('wxt/utils/storage', () => ({ storage: {
  getItem: vi.fn(async (key: string) => structuredClone(data.get(key))),
  setItem: vi.fn(async (key: string, value: unknown) => { data.set(key, structuredClone(value)); }),
  snapshot: async (area: string) => Object.fromEntries([...data].filter(([key]) => key.startsWith(area + ':')).map(([key, value]) => [key.slice(area.length + 1), value])),
  removeItems: async (keys: string[]) => keys.forEach(key => data.delete(key)),
} }));
import { storage } from 'wxt/utils/storage';
import { readConfig, hasOutboundConfirmation, deleteApiKey, clearAllSessions, saveSearchConfig, applySettings, writeConfig, saveApiKey } from '../src/background/store';
import { outboundScope, OUTBOUND_NOTICE_VERSION } from '../src/core/settings';
import { effectiveAgentSettings, runtimeAgentSettings } from '../src/core/search/agent-policy';
import { DEFAULT_SEARCH_AGENT_POLICY } from '../src/core/prompts/search-agent';
const legacy = { enabled: true, policy: 'saved policy', depth: 'quick' as const, language: 'fr', region: 'CA', sourceReading: 'off' as const, freshness: 'day' as const, preferredDomains: ['old.example'] };
beforeEach(() => { data.clear(); vi.mocked(storage.setItem).mockReset().mockImplementation(async (key, value) => { data.set(key, structuredClone(value)); }); });
it('retains old agent records but none of their policy or preferences affect product defaults', async () => {
  data.set('local:config', { apiKeys: { deepseek: 'model-secret' }, prompts: { guide: 'guide', answer: 'answer', learn: 'learn' }, search: { providerId: 'tavily', credentials: { tavily: { apiKey: 'search-secret' } }, agent: legacy } });
  expect(effectiveAgentSettings(await readConfig())).toEqual({ enabled: false, freshness: 'auto', depth: 'deep', language: '', region: '', preferredDomains: [], sourceReading: 'provider', policy: DEFAULT_SEARCH_AGENT_POLICY });
  await saveSearchConfig({ providerId: 'firecrawl' });
  expect(await readConfig()).toMatchObject({ apiKeys: { deepseek: 'model-secret' }, prompts: { guide: 'guide', answer: 'answer', learn: 'learn' }, search: { agent: legacy, credentials: { tavily: { apiKey: 'search-secret' } } } });
});
it('confirmation covers effective receiver scope, not ignored preferences or private keys', () => {
  const config = { provider: 'deepseek' as const, search: { providerId: 'searxng', credentials: { searxng: { baseUrl: 'https://one.example/path', apiKey: 'secret' } } } };
  const scope = outboundScope(config);
  expect(scope).not.toContain('secret'); expect(scope).toContain('https://one.example');
  expect(outboundScope({ ...config, search: { ...config.search, agent: legacy } })).toBe(scope);
  expect(JSON.parse(scope).sourceReading).toBe(effectiveAgentSettings({ search: { agent: legacy } }).sourceReading);
  const accepted = { ...config, outbound: { version: OUTBOUND_NOTICE_VERSION, acceptedAt: 1, receiver: 'DeepSeek（深度求索）', scope } };
  expect(hasOutboundConfirmation(accepted)).toBe(true);
  expect(hasOutboundConfirmation({ ...accepted, outbound: { ...accepted.outbound, version: '2026-10-01.1' } })).toBe(false);
  expect(hasOutboundConfirmation({ ...accepted, search: { ...accepted.search, credentials: { searxng: { baseUrl: 'https://two.example' } } } })).toBe(false);
  expect(hasOutboundConfirmation({ ...accepted, search: { ...accepted.search, agent: { sourceReading: 'off' } } })).toBe(true);
});
it('old source-reading-off confirmation cannot authorize the restored product default', () => {
  const config = { provider: 'deepseek' as const, search: { providerId: 'firecrawl', agent: { sourceReading: 'off' as const } } };
  const oldScope = JSON.stringify({ ...JSON.parse(outboundScope(config)), version: '2026-10-01.1', sourceReading: 'off', contentReceiver: null });
  expect(hasOutboundConfirmation({ ...config, outbound: { version: '2026-10-01.1', acceptedAt: 1, receiver: 'DeepSeek（深度求索）', scope: oldScope } })).toBe(false);
  expect(JSON.parse(outboundScope(config))).toMatchObject({ sourceReading: 'provider', contentReceiver: 'https://api.firecrawl.dev', directRead: false });
});
it('resolves browser locale regardless of saved locale preferences', () => {
  expect(runtimeAgentSettings({}, 'zh-Hant-TW')).toMatchObject({ language: 'zh-Hant-TW', region: 'TW' });
  expect(runtimeAgentSettings({}, 'en')).toMatchObject({ language: 'en', region: '' });
  expect(runtimeAgentSettings({ search: { agent: legacy } }, 'en-US')).toMatchObject({ language: 'en-US', region: 'US' });
});
it('key deletion and session clearing preserve inert records, search credentials and original prompts', async () => {
  data.set('local:config', { apiKeys: { deepseek: 'model-private' }, search: { providerId: 'tavily', credentials: { tavily: { apiKey: 'search-private' } }, agent: legacy }, prompts: { answer: 'answer policy' } });
  data.set('session:sess:7', { chat: ['conversation'] });
  await deleteApiKey('deepseek');
  expect((await readConfig()).search?.agent).toEqual(legacy);
  expect(data.has('session:sess:7')).toBe(true);
  expect(await clearAllSessions()).toBe(1);
  expect(await readConfig()).toMatchObject({ search: { credentials: { tavily: { apiKey: 'search-private' } } }, prompts: { answer: 'answer policy' } });
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function holdFirstWrite() {
  const started = deferred(); const release = deferred();
  vi.mocked(storage.setItem).mockImplementationOnce(async (key, value) => { started.resolve(); await release.promise; data.set(key, structuredClone(value)); });
  return { started: started.promise, release: release.resolve };
}
describe('shared configuration transactions retain inert legacy records', () => {
  it.each([
    ['search provider', () => saveSearchConfig({ providerId: 'tavily', credentials: { apiKey: 'search-private' } }), { search: { providerId: 'tavily', credentials: { tavily: { apiKey: 'search-private' } } } }],
    ['model provider', () => applySettings({ provider: 'zhipu' }), { provider: 'zhipu' }],
    ['general configuration', () => writeConfig({ diagrams: 'off' }), { diagrams: 'off' }],
    ['model key', () => saveApiKey('zhipu', 'new-private'), { apiKeys: { zhipu: 'new-private' } }],
  ] as const)('preserves original prompts and old preferences through overlapping %s save', async (_name, saveOther, expected) => {
    data.set('local:config', { apiKeys: { deepseek: 'model-private' }, search: { agent: legacy } });
    const held = holdFirstWrite();
    const prompts = applySettings({ prompts: { guide: 'guide', answer: 'answer', learn: 'learn' } }); await held.started;
    const other = saveOther(); await Promise.resolve(); held.release(); await Promise.all([prompts, other]);
    expect(await readConfig()).toMatchObject({ ...expected, prompts: { guide: 'guide', answer: 'answer', learn: 'learn' }, apiKeys: { deepseek: 'model-private' } });
    expect((await readConfig()).search?.agent).toEqual(legacy);
  });
  it('serializes migration with a concurrent normal settings save', async () => {
    data.set('local:config', { apiKey: 'legacy-private', model: 'legacy-model' });
    const held = holdFirstWrite(); const migration = readConfig(); await held.started;
    const settings = applySettings({ diagrams: 'off' }); await Promise.resolve(); held.release(); await Promise.all([migration, settings]);
    expect(await readConfig()).toMatchObject({ apiKeys: { deepseek: 'legacy-private' }, models: { deepseek: 'legacy-model' }, diagrams: 'off' });
    expect(await readConfig()).not.toHaveProperty('apiKey');
  });
  it('recovers its queue after a failed normal settings write', async () => {
    data.set('local:config', { search: { agent: legacy } });
    const held = deferred(); const started = deferred();
    vi.mocked(storage.setItem).mockImplementationOnce(async () => { started.resolve(); await held.promise; throw new Error('write failed'); });
    const failed = applySettings({ fontSize: 'large' }); const rejection = expect(failed).rejects.toThrow('write failed'); await started.promise;
    const accepted = applySettings({ diagrams: 'off' }); held.resolve(); await Promise.all([rejection, accepted]);
    expect(await readConfig()).toMatchObject({ search: { agent: legacy }, diagrams: 'off' });
  });
});
