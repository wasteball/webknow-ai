import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSession } from '../src/core/session';
import type { Config } from '../src/background/store';
const boundary = vi.hoisted(() => ({
  config: {} as Config, session: null as PageSession | null, confirmed: true,
  identity: { url: 'https://example.org/article', fingerprint: 'fp' },
  key: 'test-secret-key', json: vi.fn(), fetch: vi.fn(),
  permission: vi.fn(async (_input: { origins: string[] }) => true),
  readKey: vi.fn(async () => 'test-secret-key'),
}));
vi.mock('../src/background/store', () => ({
  getSession: vi.fn(async () => structuredClone(boundary.session)),
  putSession: vi.fn(async (session: PageSession) => { boundary.session = structuredClone(session); }),
  readConfig: vi.fn(async () => structuredClone(boundary.config)),
  readApiKey: boundary.readKey, readSearchCredentials: vi.fn(async () => ({})),
  hasOutboundConfirmation: () => boundary.confirmed,
}));
vi.mock('../src/background/page', () => ({
  readPageIdentity: vi.fn(async () => ({ ...boundary.identity })), toAppError: (e: unknown) => e,
}));
vi.mock('../src/core/model-call', () => ({ chatJson: boundary.json }));
vi.mock('wxt/browser', () => ({ browser: { permissions: { contains: boundary.permission } } }));
import { emptySession } from '../src/core/session';
import { handleIntent, abortRun, recoverInterruptedRun } from '../src/background/runner';
import { callResearchModel } from '../src/background/model';
import { initialCheckpoint } from '../src/core/search/agent-limits';
import { snapshotFixture } from './helpers/research';
import { executeResearch } from '../src/background/research';
const hooks = { onState: vi.fn(), onProgress: vi.fn() };
function activeCheckpoint() {
  const snapshot = snapshotFixture({ searchProviderId: 'firecrawl',
    identity: { ...snapshotFixture().identity, modelId: 'deepseek-flash' }, thinking: 'off',
    gate: { level: 'recommended', canSearch: true, mustSearch: false, freshness: 'any', reasons: [],
      time: { nowIso: new Date().toISOString(), localDate: '2026-10-01', timeZone: 'Asia/Shanghai', from: '2026-09-01', to: '2026-09-30' } } });
  boundary.session = { ...emptySession(7, snapshot.identity.url), id: 's1', state: 'READY', fingerprint: 'fp',
    blocks: snapshot.blocks, run: { id: 'r1', kind: 'answer', startedAt: Date.now() } };
  return initialCheckpoint(snapshot, Date.now());
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.config = { provider: 'deepseek', search: { providerId: 'firecrawl', agent: { enabled: true } } };
  boundary.confirmed = true; boundary.identity = { url: 'https://example.org/article', fingerprint: 'fp' };
  boundary.permission.mockReset().mockResolvedValue(true); boundary.readKey.mockReset().mockResolvedValue('test-secret-key');
  boundary.json.mockReset(); boundary.fetch.mockReset(); vi.stubGlobal('fetch', boundary.fetch);
  activeCheckpoint(); boundary.session!.run = null;
});
afterEach(async () => { abortRun(7); await recoverInterruptedRun(7); vi.unstubAllGlobals(); });

const search = { type: 'search_web', query: 'release facts', purpose: 'background', freshness: 'any', language: 'zh-CN', domains: [], maxResults: 3 };
const wait = { type: 'ask_user', reason: 'conflict', question: '你想核对哪个结论？' };
const evidence = { sources: [{ sourceId: 'sr_r1_1', relevant: true, supportedAspects: ['release'], reason: 'primary' }], missing: [], conflicts: [] };

describe('real backend research adapters', () => {
  it('runs real handleIntent through model/search/read, persists audited accepted source links and only safe summaries', async () => {
    // Real orchestrator owns the generated source ID, so obtain it from the fixed assessment payload.
    let sourceId = '';
    boundary.json.mockReset()
      .mockResolvedValueOnce(search)
      .mockImplementationOnce(async ({ messages }) => {
        sourceId = /sr_[A-Za-z0-9_]+_1/.exec(messages[1].content)![0];
        return { ...evidence, sources: [{ ...evidence.sources[0], sourceId }] };
      })
      .mockImplementationOnce(async () => ({ type: 'read_sources', sourceIds: [sourceId], focus: 'release' }))
      .mockImplementationOnce(async () => ({ ...evidence, sources: [{ ...evidence.sources[0], sourceId }] }))
      .mockImplementationOnce(async () => ({ type: 'finish_answer', answer: '根据网络资料，发布说明包含这一结论。', source: 'extended', citations: [], references: [sourceId], unanswered: [], freshness: 'not_applicable' }))
      .mockImplementationOnce(async () => ({ decision: 'accept', claims: [{ text: '发布说明包含这一结论', sourceIds: [sourceId] }], missing: [], conflicts: [], freshness: 'not_applicable' }));
    boundary.fetch.mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith('/search')
      ? { data: { web: [{ title: '发布说明', url: 'https://example.net/release', description: '结论摘要' }] } }
      : { data: { markdown: 'SECRET_SOURCE_BODY 发布说明包含这一结论。' } }), { headers: { 'Content-Type': 'application/json' } }));
    expect(await handleIntent({ kind: 'ask', tabId: 7, question: '查证发布说明', network: 'force' }, hooks)).toBeNull();
    expect(boundary.session?.chat[0]?.webReferences?.[0]?.url).toBe('https://example.net/release');
    expect(boundary.session?.chat[0]?.research?.sources[0]?.readStatus).toBe('read');
    expect(JSON.stringify(boundary.session)).not.toContain('SECRET_SOURCE_BODY');
    expect(JSON.stringify(boundary.session)).not.toContain('test-secret-key');
    expect(boundary.session?.researchCheckpoint).toBeUndefined();
    expect(boundary.fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://api.firecrawl.dev/v2/search', 'https://api.firecrawl.dev/v2/scrape']);
    expect(boundary.json.mock.calls.every(([request]) => request.model === 'deepseek-flash' && request.thinking === 'off')).toBe(true);
    expect(String(boundary.fetch.mock.calls[0]?.[1]?.body)).not.toContain('样本');
  });
  it('passes the original frozen gate time to real search provider filtering', async () => {
    const checkpoint = activeCheckpoint();
    boundary.json.mockResolvedValueOnce({ ...search, freshness: 'live' }).mockResolvedValueOnce({ sources: [], missing: [], conflicts: [] }).mockResolvedValueOnce(wait);
    boundary.fetch.mockResolvedValue(new Response(JSON.stringify({ data: { web: [] } })));
    const outcome = await executeResearch(checkpoint, new AbortController().signal, vi.fn());
    expect(outcome.kind).toBe('waiting');
    expect(JSON.parse(boundary.fetch.mock.calls[0]?.[1]?.body)).not.toHaveProperty('tbs');
    expect(outcome.checkpoint.snapshot.gate.time.from).toBe('2026-09-01');
  });
  it('direct_allowed never enables direct requests for an unverified reader or Tavily content', async () => {
    const checkpoint = activeCheckpoint(); checkpoint.snapshot.settings.sourceReading = 'direct_allowed';
    checkpoint.snapshot.searchProviderId = 'tavily'; boundary.config.search!.providerId = 'tavily';
    checkpoint.ledger.sources = [{ sourceId: 'sr_r1_1', title: 'release', url: 'https://example.net/release', domain: 'example.net', snippet: 'summary',
      provider: 'tavily', attempts: [], publishedAt: null, retrievedAt: new Date().toISOString(), readStatus: 'not_read', decision: 'candidate', dateStatus: 'date_unknown', warnings: [] }];
    boundary.json.mockResolvedValueOnce({ type: 'read_sources', sourceIds: ['sr_r1_1'], focus: 'release' }).mockResolvedValueOnce(evidence).mockResolvedValueOnce(wait);
    const outcome = await executeResearch(checkpoint, new AbortController().signal, vi.fn());
    expect(outcome.checkpoint.ledger.sources[0]?.readStatus).toBe('unavailable');
    expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it.each(['permission', 'consent', 'key', 'page', 'provider', 'model', 'network', 'searchReceiver'] as const)('does not transmit after %s is revoked while waiting', async change => {
    const checkpoint = activeCheckpoint();
    checkpoint.waiting = { type: 'ask_user', reason: 'conflict', question: '核对哪一点？' };
    if (change === 'permission') boundary.permission.mockResolvedValue(false);
    if (change === 'consent') boundary.confirmed = false;
    if (change === 'key') boundary.readKey.mockResolvedValue('');
    if (change === 'page') boundary.identity.fingerprint = 'changed';
    if (change === 'provider') boundary.config.provider = 'zhipu';
    if (change === 'model') boundary.config.models = { deepseek: 'deepseek-v4-pro' };
    if (change === 'network') boundary.config.search!.agent!.enabled = false;
    if (change === 'searchReceiver') boundary.config.search!.providerId = 'bing';
    await expect(executeResearch(checkpoint, new AbortController().signal, vi.fn(), { mode: 'continue', text: '发布说明' })).rejects.toBeDefined();
    expect(boundary.json).not.toHaveBeenCalled(); expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it('rechecks model and consent after key lookup at the actual model egress', async () => {
    const checkpoint = activeCheckpoint();
    boundary.readKey.mockImplementationOnce(async () => { boundary.config.provider = 'zhipu'; return 'old-key'; });
    await expect(callResearchModel({ identity: checkpoint.snapshot.identity, thinking: 'off', messages: [], signal: new AbortController().signal })).rejects.toMatchObject({ code: 'STALE_PAGE' });
    expect(boundary.json).not.toHaveBeenCalled();
  });
  it('rechecks receiver after permission lookup before the model request', async () => {
    const checkpoint = activeCheckpoint();
    boundary.permission.mockImplementation(async () => { boundary.config.provider = 'zhipu'; return true; });
    await expect(callResearchModel({ identity: checkpoint.snapshot.identity, thinking: 'off', messages: [], signal: new AbortController().signal })).rejects.toMatchObject({ code: 'STALE_PAGE' });
    expect(boundary.json).not.toHaveBeenCalled();
  });
});
