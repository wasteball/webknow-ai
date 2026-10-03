import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSession } from '../src/core/session';
import type { Config } from '../src/background/store';
const boundary = vi.hoisted(() => ({
  config: {} as Config, sessions: new Map<number, PageSession>(), confirmed: true,
  identity: { url: 'https://example.org/article', fingerprint: 'fp' },
  json: vi.fn(), fetch: vi.fn(),
  permission: vi.fn(async (_input: { origins: string[] }) => true),
  readKey: vi.fn(async () => 'test-secret-key'), readConfig: vi.fn<() => Promise<Config>>(),
}));
vi.mock('../src/background/store', () => ({
  getSession: vi.fn(async (tabId: number) => structuredClone(boundary.sessions.get(tabId) ?? null)),
  putSession: vi.fn(async (session: PageSession) => { boundary.sessions.set(session.tabId, structuredClone(session)); }),
  readConfig: boundary.readConfig,
  readApiKey: boundary.readKey, readSearchCredentials: vi.fn(async (providerId: string) => ({ ...boundary.config.search?.credentials?.[providerId] })),
  hasOutboundConfirmation: () => boundary.confirmed,
}));
vi.mock('../src/background/page', () => ({ readPageIdentity: vi.fn(async () => ({ ...boundary.identity })), toAppError: (e: unknown) => e }));
vi.mock('../src/core/model-call', () => ({ chatJson: boundary.json }));
vi.mock('wxt/browser', () => ({ browser: { i18n: { getUILanguage: () => 'zh-Hant-TW' }, permissions: { contains: boundary.permission } } }));
import { emptySession } from '../src/core/session';
import { handleIntent, abortRun, recoverInterruptedRun } from '../src/background/runner';
import { callResearchModel } from '../src/background/model';
import { initialCheckpoint } from '../src/core/search/agent-limits';
import { snapshotFixture } from './helpers/research';
import { outboundScope } from '../src/core/settings';
import { bocha, firecrawl, tavily, searxng } from '../src/core/search/providers';
import { executeResearch } from '../src/background/research';
const hooks = { onState: vi.fn(), onProgress: vi.fn() };
const wait = { type: 'ask_user', reason: 'conflict', question: '你想核对哪个结论？' } as const;
const search = { type: 'search_web', query: 'release facts', purpose: 'background', freshness: 'any', language: 'zh-CN', domains: [], maxResults: 3 };
const evidence = { sources: [{ sourceId: 'sr_test_1', relevant: true, supportedAspects: ['release'], reason: 'primary' }], missing: [], conflicts: [] };
function session(tabId = 7) { return boundary.sessions.get(tabId)!; }
function seed(tabId = 7) {
  boundary.sessions.set(tabId, { ...emptySession(tabId, boundary.identity.url), state: 'READY', fingerprint: 'fp', blocks: snapshotFixture().blocks });
}
/** Authorization comes from real runner registration; checkpoints alone never grant permission. */
async function activeCheckpoint(tabId = 7) {
  boundary.json.mockResolvedValueOnce(wait);
  expect(await handleIntent({ kind: 'ask', tabId, question: '比较外部发布资料', search: true }, hooks)).toBeNull();
  const checkpoint = session(tabId).researchCheckpoint!;
  expect(checkpoint).toBeDefined();
  checkpoint.waiting = null;
  boundary.json.mockReset(); boundary.permission.mockClear(); boundary.readKey.mockClear();
  return checkpoint;
}
function addSource(checkpoint: Awaited<ReturnType<typeof activeCheckpoint>>) {
  const sourceId = `sr_${checkpoint.snapshot.identity.runId}_1`;
  checkpoint.ledger.sources = [{ sourceId, title: 'release', url: 'https://example.net/release', domain: 'example.net', snippet: 'summary',
    provider: checkpoint.snapshot.searchProviderId!, attempts: [], publishedAt: null, retrievedAt: new Date().toISOString(), readStatus: 'not_read', decision: 'candidate', dateStatus: 'date_unknown', warnings: [] }];
  return sourceId;
}
function modelRequest(checkpoint: Awaited<ReturnType<typeof activeCheckpoint>>) {
  return { identity: checkpoint.snapshot.identity, thinking: checkpoint.snapshot.thinking, searchProviderId: checkpoint.snapshot.searchProviderId,
    outboundScope: checkpoint.snapshot.outboundScope, messages: [], signal: new AbortController().signal };
}
beforeEach(() => {
  vi.clearAllMocks(); boundary.sessions.clear();
  boundary.config = { provider: 'deepseek', apiKeys: { deepseek: 'test-secret-key' }, search: { providerId: 'firecrawl', agent: { enabled: false } } };
  boundary.confirmed = true; boundary.identity = { url: 'https://example.org/article', fingerprint: 'fp' };
  boundary.permission.mockReset().mockResolvedValue(true); boundary.readKey.mockReset().mockResolvedValue('test-secret-key');
  boundary.readConfig.mockReset().mockImplementation(async () => structuredClone(boundary.config));
  boundary.json.mockReset(); boundary.fetch.mockReset(); vi.stubGlobal('fetch', boundary.fetch); seed();
});
afterEach(async () => { for (const tabId of boundary.sessions.keys()) { abortRun(tabId); await recoverInterruptedRun(tabId); } vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('real registered backend research adapters', () => {
  it('runs model/search/read despite legacy disabled and persists audited safe source summaries', async () => {
    let sourceId = '';
    boundary.json.mockResolvedValueOnce(search)
      .mockImplementationOnce(async ({ messages }) => { sourceId = /sr_[A-Za-z0-9_]+_1/.exec(messages[1].content)![0]; return { ...evidence, sources: [{ ...evidence.sources[0], sourceId }] }; })
      .mockImplementationOnce(async () => ({ type: 'read_sources', sourceIds: [sourceId], focus: 'release' }))
      .mockImplementationOnce(async () => ({ ...evidence, sources: [{ ...evidence.sources[0], sourceId }] }))
      .mockImplementationOnce(async () => ({ type: 'finish_answer', answer: '根据网络资料，发布说明包含这一结论。', source: 'extended', citations: [], references: [sourceId], unanswered: [], freshness: 'not_applicable' }))
      .mockImplementationOnce(async () => ({ decision: 'accept', claims: [{ text: '发布说明包含这一结论', sourceIds: [sourceId] }], missing: [], conflicts: [], freshness: 'not_applicable' }));
    boundary.fetch.mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith('/search')
      ? { data: { web: [{ title: '发布说明', url: 'https://example.net/release', description: '结论摘要' }] } }
      : { data: { markdown: 'SECRET_SOURCE_BODY 发布说明包含这一结论。' } }), { headers: { 'Content-Type': 'application/json' } }));
    expect(await handleIntent({ kind: 'ask', tabId: 7, question: '比较外部发布资料', search: true }, hooks)).toBeNull();
    expect(session().chat[0]?.webReferences?.[0]?.url).toBe('https://example.net/release');
    expect(session().chat[0]?.research?.sources[0]?.readStatus).toBe('read');
    expect(JSON.stringify(session())).not.toMatch(/SECRET_SOURCE_BODY|test-secret-key/);
    expect(session().researchCheckpoint).toBeUndefined();
    expect(boundary.fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://api.firecrawl.dev/v2/search', 'https://api.firecrawl.dev/v2/scrape']);
    expect(boundary.json.mock.calls.every(([request]) => request.model === 'deepseek-flash' && request.thinking === 'off')).toBe(true);
    expect(String(boundary.fetch.mock.calls[0]?.[1]?.body)).not.toContain('试点');
  });
  it('a persisted checkpoint without registration cannot authorize model or search egress', async () => {
    boundary.config.search!.agent = { enabled: true };
    const checkpoint = initialCheckpoint(snapshotFixture({ searchProviderId: 'firecrawl', outboundScope: outboundScope(boundary.config),
      identity: { ...snapshotFixture().identity, modelId: 'deepseek-flash' }, thinking: 'off',
      gate: { ...snapshotFixture().gate, time: { ...snapshotFixture().gate.time, nowIso: new Date().toISOString() } } }), Date.now());
    boundary.sessions.set(7, { ...session(), id: 's1', run: { id: 'r1', kind: 'answer', startedAt: Date.now() }, researchCheckpoint: checkpoint });
    boundary.json.mockResolvedValue(wait);
    await expect(callResearchModel(modelRequest(checkpoint))).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(executeResearch(checkpoint, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'ABORTED' });
    expect(boundary.json).not.toHaveBeenCalled(); expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it('passes the original frozen gate time to search provider filtering', async () => {
    const checkpoint = await activeCheckpoint(); checkpoint.snapshot.gate.time = { ...checkpoint.snapshot.gate.time, from: '2026-09-01', to: '2026-09-30' };
    boundary.json.mockResolvedValueOnce({ ...search, freshness: 'live' }).mockResolvedValueOnce({ sources: [], missing: [], conflicts: [] }).mockResolvedValueOnce(wait);
    boundary.fetch.mockResolvedValue(new Response(JSON.stringify({ data: { web: [] } })));
    const outcome = await executeResearch(checkpoint, new AbortController().signal, vi.fn());
    expect(outcome.kind).toBe('waiting'); expect(JSON.parse(boundary.fetch.mock.calls[0]?.[1]?.body)).not.toHaveProperty('tbs');
    expect(outcome.checkpoint.snapshot.gate.time.from).toBe('2026-09-01');
  });
  it('article continuation completes model/audit but cannot use search or source reading', async () => {
    const checkpoint = await activeCheckpoint(); checkpoint.waiting = wait;
    session().researchCheckpoint!.snapshot.gate.canSearch = false;
    boundary.json.mockResolvedValueOnce({ type: 'finish_answer', answer: '试点只有三个团队。', source: 'original', citations: ['b_0'], references: [], unanswered: [], freshness: 'not_applicable' })
      .mockResolvedValueOnce({ decision: 'accept', claims: [], missing: [], conflicts: [], freshness: 'not_applicable' });
    const outcome = await executeResearch(checkpoint, new AbortController().signal, vi.fn(), { mode: 'article', text: '仅解释文中试点' });
    expect(outcome.kind).toBe('finished');
    if (outcome.kind === 'finished') expect(outcome.answer).toMatchObject({ answer: '试点只有三个团队。\n\n仅依据当前文章，未联网核验。', source: 'original' });
    expect(boundary.json).toHaveBeenCalledTimes(2); expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it.each(['permission', 'consent', 'key', 'page', 'provider', 'model', 'stop', 'searchReceiver'] as const)('does not transmit after %s is revoked while waiting', async change => {
    const checkpoint = await activeCheckpoint(); checkpoint.waiting = wait;
    if (change === 'permission') boundary.permission.mockResolvedValue(false);
    if (change === 'consent') boundary.confirmed = false;
    if (change === 'key') boundary.readKey.mockResolvedValue('');
    if (change === 'page') boundary.identity.fingerprint = 'changed';
    if (change === 'provider') boundary.config.provider = 'zhipu';
    if (change === 'model') boundary.config.models = { deepseek: 'deepseek-v4-pro' };
    if (change === 'stop') abortRun(7);
    if (change === 'searchReceiver') boundary.config.search!.providerId = 'bing';
    await expect(executeResearch(checkpoint, new AbortController().signal, vi.fn(), { mode: 'continue', text: '发布说明' })).rejects.toBeDefined();
    expect(boundary.json).not.toHaveBeenCalled(); expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it.each(['key', 'permission', 'storage'] as const)('rechecks active permission after model %s await', async stage => {
    const checkpoint = await activeCheckpoint();
    if (stage === 'key') boundary.readKey.mockImplementationOnce(async () => { abortRun(7); return 'test-secret-key'; });
    if (stage === 'permission') boundary.permission.mockImplementationOnce(async () => { abortRun(7); return true; });
    if (stage === 'storage') boundary.readConfig.mockImplementationOnce(async () => structuredClone(boundary.config))
      .mockImplementationOnce(async () => { abortRun(7); return structuredClone(boundary.config); });
    await expect(callResearchModel(modelRequest(checkpoint))).rejects.toMatchObject({ code: 'ABORTED' });
    expect(boundary.json).not.toHaveBeenCalled();
  });
  it.each(['provider', 'consent', 'page', 'searchReceiver', 'permission'] as const)('rechecks %s after model key await', async change => {
    const checkpoint = await activeCheckpoint();
    boundary.readKey.mockImplementationOnce(async () => {
      if (change === 'provider') boundary.config.provider = 'zhipu';
      if (change === 'consent') boundary.confirmed = false;
      if (change === 'page') boundary.identity.fingerprint = 'changed';
      if (change === 'searchReceiver') boundary.config.search!.providerId = 'bing';
      if (change === 'permission') boundary.permission.mockResolvedValue(false);
      return 'test-secret-key';
    });
    await expect(callResearchModel(modelRequest(checkpoint))).rejects.toBeDefined(); expect(boundary.json).not.toHaveBeenCalled();
  });
  it('stopping one registered tab leaves the other tab authorized', async () => {
    const first = await activeCheckpoint(); seed(8); const second = await activeCheckpoint(8);
    abortRun(7); boundary.json.mockResolvedValue(wait);
    await expect(callResearchModel(modelRequest(first))).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(callResearchModel(modelRequest(second))).resolves.toEqual(wait);
    expect(boundary.json).toHaveBeenCalledOnce();
  });
});

describe('physical search and provider-content egress', () => {
  it.each([['tavily', ''], ['tavily', 'rotated-search-key'], ['bocha', ''], ['bocha', 'rotated-search-key']] as const)('blocks obsolete %s authentication changed to %j after preparation', async (providerId, replacement) => {
    boundary.config.search = { providerId, credentials: { [providerId]: { apiKey: 'obsolete-search-key' } } };
    const checkpoint = await activeCheckpoint(); const provider = providerId === 'tavily' ? tavily : bocha; const original = provider.search;
    vi.spyOn(provider, 'search').mockImplementation(async request => { boundary.config.search!.credentials![providerId] = { apiKey: replacement }; return original(request); });
    boundary.json.mockResolvedValueOnce(search).mockResolvedValueOnce({ sources: [], missing: [], conflicts: [] }).mockResolvedValueOnce(wait);
    const outcome = await executeResearch(checkpoint, new AbortController().signal, vi.fn());
    expect(outcome.kind).toBe('waiting'); expect(boundary.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toMatch(/obsolete-search-key|rotated-search-key/);
  });
  it.each(['tavily', 'bocha'] as const)('allows unchanged %s authentication at physical egress', async providerId => {
    boundary.config.search = { providerId, credentials: { [providerId]: { apiKey: 'current-search-key' } } };
    const checkpoint = await activeCheckpoint();
    boundary.json.mockResolvedValueOnce(search).mockResolvedValueOnce({ sources: [], missing: [], conflicts: [] }).mockResolvedValueOnce(wait);
    boundary.fetch.mockResolvedValue(new Response(JSON.stringify({ results: [], data: { webPages: { value: [] } } })));
    expect((await executeResearch(checkpoint, new AbortController().signal, vi.fn())).kind).toBe('waiting');
    expect(boundary.fetch).toHaveBeenCalledOnce(); expect(new Headers(boundary.fetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer current-search-key');
  });
  it.each(['', 'rotated-model-key'])('blocks model Key changed after preparation to %j', async replacement => {
    const checkpoint = await activeCheckpoint();
    boundary.readKey.mockImplementationOnce(async () => { boundary.config.apiKeys = { deepseek: replacement }; return 'test-secret-key'; });
    await expect(callResearchModel(modelRequest(checkpoint))).rejects.toBeDefined(); expect(boundary.json).not.toHaveBeenCalled();
  });
  it.each(['key', 'stop', 'receiver', 'consent', 'checkpoint'] as const)('blocks provider-content %s revocation after preparation', async change => {
    boundary.config.search!.credentials = { firecrawl: { apiKey: 'obsolete-content-key' } };
    const checkpoint = await activeCheckpoint(); const sourceId = addSource(checkpoint); const original = firecrawl.readSources!;
    vi.spyOn(firecrawl, 'readSources').mockImplementation(async input => {
      if (change === 'key') boundary.config.search!.credentials!.firecrawl = { apiKey: 'rotated-content-key' };
      if (change === 'stop') abortRun(7);
      if (change === 'receiver') boundary.config.search!.providerId = 'bing';
      if (change === 'consent') boundary.confirmed = false;
      if (change === 'checkpoint') session().researchCheckpoint!.snapshot.settings.enabled = false;
      return original(input);
    });
    boundary.json.mockResolvedValueOnce({ type: 'read_sources', sourceIds: [sourceId], focus: 'release' }).mockResolvedValueOnce({ ...evidence, sources: [{ ...evidence.sources[0], sourceId }] }).mockResolvedValueOnce(wait);
    await executeResearch(checkpoint, new AbortController().signal, vi.fn()).catch(() => {});
    expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it.each(['stop', 'scope', 'checkpoint', 'gate', 'permission', 'consent'] as const)('blocks search %s revocation at actual provider fetch', async change => {
    const checkpoint = await activeCheckpoint(); const original = firecrawl.search;
    vi.spyOn(firecrawl, 'search').mockImplementation(async input => {
      if (change === 'stop') abortRun(7);
      if (change === 'scope') boundary.config.search!.providerId = 'bing';
      if (change === 'checkpoint') session().researchCheckpoint!.snapshot.settings.enabled = false;
      if (change === 'gate') session().researchCheckpoint!.snapshot.gate.canSearch = false;
      if (change === 'permission') boundary.permission.mockResolvedValue(false);
      if (change === 'consent') boundary.confirmed = false;
      return original(input);
    });
    boundary.json.mockResolvedValueOnce(search).mockResolvedValueOnce({ sources: [], missing: [], conflicts: [] }).mockResolvedValueOnce(wait);
    await executeResearch(checkpoint, new AbortController().signal, vi.fn()).catch(() => {});
    expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it('blocks prepared self-host search after receiver origin changes', async () => {
    boundary.config.search = { providerId: 'searxng', credentials: { searxng: { baseUrl: 'https://one.example' } } };
    const checkpoint = await activeCheckpoint(); const original = searxng.search;
    vi.spyOn(searxng, 'search').mockImplementation(async request => { boundary.config.search!.credentials!.searxng!.baseUrl = 'https://two.example'; return original(request); });
    boundary.json.mockResolvedValueOnce(search);
    await expect(executeResearch(checkpoint, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'STALE_PAGE' });
    expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it('ignores saved locale, policy and reading preferences in frozen model context', async () => {
    boundary.config.search!.agent = { enabled: false, language: 'fr', region: 'CA', sourceReading: 'off', depth: 'quick', policy: 'OLD_POLICY' };
    boundary.json.mockImplementationOnce(async ({ messages }) => {
      const context = JSON.parse(messages[1].content.split('\n')[1]);
      expect(context.settings).toMatchObject({ enabled: true, language: 'zh-Hant-TW', region: 'TW', sourceReading: 'provider', depth: 'deep' });
      expect(context.policy).not.toBe('OLD_POLICY'); expect(context).not.toHaveProperty('outboundScope'); return wait;
    });
    expect(await handleIntent({ kind: 'ask', tabId: 7, question: '比较外部发布资料', search: true }, hooks)).toBeNull();
    expect(session().researchCheckpoint?.snapshot.settings).toMatchObject({ language: 'zh-Hant-TW', region: 'TW', depth: 'deep', sourceReading: 'provider' });
  });
});
