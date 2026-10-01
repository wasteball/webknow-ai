import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../src/core/limits';
import type { SearchAction } from '../src/core/search/agent-types';
import { BUILTIN_SEARCH_PROVIDERS, researchSearch } from '../src/core/search/registry';
import { buildTimeContext } from '../src/core/search/time';

const action: SearchAction = {
  type: 'search_web', query: '试点官方数据', purpose: 'fact_check',
  freshness: 'week', language: 'zh-CN', domains: [], maxResults: 5,
};
const now = () => new Date('2026-10-01T08:00:00Z');
function search(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof researchSearch>[0]> = {}) {
  return researchSearch({
    providerId: 'tavily', config: { apiKey: 'test-search-key' }, action,
    signal: new AbortController().signal, now, fetchImpl, ...overrides,
  });
}
const jsonFetch = (payload: unknown, status = 200) => vi.fn<typeof fetch>(async () =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }));
const result = { title: 'T', url: 'https://example.com/a', content: '摘要' };
afterEach(() => vi.restoreAllMocks());

describe('research search provider contract', () => {
  it('distinguishes empty evidence and keeps the service payload narrow and authentication separate', async () => {
    const fetchImpl = jsonFetch({ results: [] });
    const batch = await search(fetchImpl, {
      config: { apiKey: 'test-search-key', blocks: 'private article', policy: 'secret policy' },
      action: { ...action, blocks: 'private article', messages: ['history'], policy: 'policy' } as SearchAction,
    });
    expect(batch).toMatchObject({ status: 'empty', results: [], provider: 'tavily', retrievedAt: now().toISOString() });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ query: action.query, max_results: 5, search_depth: 'basic', time_range: 'week', filter_by_published_date: true });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer test-search-key' });
  });

  it.each([[500, 'transient'], [503, 'transient'], [429, 'transient'], [401, 'failed'], [403, 'failed'], [400, 'failed']])(
    'classifies HTTP %i as %s without leaking error content or retrying', async (status, expected) => {
      const fetchImpl = jsonFetch({ error: 'private key test-search-key' }, Number(status));
      const batch = await search(fetchImpl);
      expect(batch.status).toBe(expected);
      expect(JSON.stringify(batch)).not.toContain('test-search-key');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('classifies network failure as transient', async () => {
    const batch = await search(vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed'); }));
    expect(batch.status).toBe('transient');
  });
  it('classifies invalid JSON and invalid success envelopes as failed', async () => {
    expect((await search(async () => new Response('invalid json'))).status).toBe('failed');
    expect((await search(jsonFetch({ error: 'not a result envelope' }))).status).toBe('failed');
  });
  it('fails missing configuration and unknown providers without sending requests', async () => {
    const fetchImpl = jsonFetch({ results: [] });
    expect((await search(fetchImpl, { config: {} })).status).toBe('failed');
    expect((await search(fetchImpl, { providerId: 'unknown' })).status).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the independent timeout signal to fetch and classifies timeout as transient', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let sentSignal: AbortSignal | null | undefined;
    const pending = search(async (_url, init) => {
      sentSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => sentSignal!.addEventListener('abort', () => reject(sentSignal!.reason), { once: true }));
    });
    expect(timeoutSpy).toHaveBeenCalledWith(LIMITS.searchTimeoutMs);
    expect(sentSignal?.aborted).toBe(false);
    timeout.abort(new DOMException('expired', 'TimeoutError'));
    expect((await pending).status).toBe('transient');
    expect(sentSignal?.aborted).toBe(true);
  });
  it('throws ABORTED for user cancellation even when timeout also fires', async () => {
    const user = new AbortController();
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const pending = search(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }), { signal: user.signal });
    timeout.abort();
    user.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('does not fetch after an earlier cancellation or accept late success after cancellation', async () => {
    const user = new AbortController();
    const fetchImpl = jsonFetch({ results: [result] });
    user.abort();
    await expect(search(fetchImpl, { signal: user.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const late = new AbortController();
    await expect(search(async () => { late.abort(); return new Response(JSON.stringify({ results: [result] })); }, { signal: late.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('uses documented native Tavily domain/date filters and keeps date semantics explicit', async () => {
    const fetchImpl = jsonFetch({ results: [{ ...result, dateLastCrawled: '2026-10-01', published_date: '2026-09-30' }] });
    const batch = await search(fetchImpl, { action: { ...action, domains: [' EXAMPLE.COM ', 'example.com'] } });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ include_domains: ['example.com'], time_range: 'week', filter_by_published_date: true });
    expect(batch.results[0]?.publishedAt).toBeNull();
    expect(batch.warnings).toContain('publication_date_unknown');
    expect(batch.warnings).toContain('date_filter_publication_or_update');
    expect(batch.warnings).toContain('language_filter_unsupported');
  });
  it('honors the program-owned historical range instead of current coarse freshness', async () => {
    const time = { nowIso: now().toISOString(), localDate: '2026-10-01', timeZone: 'Asia/Shanghai', from: '2020-01-01', to: '2020-12-31' };
    const fetchImpl = jsonFetch({ results: [result] });
    await search(fetchImpl, { time });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ query: action.query, max_results: 5, search_depth: 'basic', start_date: '2020-01-01', end_date: '2020-12-31', filter_by_published_date: true });
    expect(body).not.toHaveProperty('time_range');
    const fallback = jsonFetch({ data: { web: [{ title: 'T', url: result.url, description: 'S' }] } });
    const batch = await search(fallback, { providerId: 'firecrawl', config: {}, time });
    const fallbackBody = JSON.parse(String(fallback.mock.calls[0]?.[1]?.body));
    expect(fallbackBody.query).toContain('after:2020-01-01 before:2020-12-31');
    expect(fallbackBody).not.toHaveProperty('tbs');
    expect(fallbackBody.query).not.toContain('2026-09');
    expect(batch.warnings).toContain('date_range_query_hint');
  });
  it('preserves timezone calendar dates from the exact gate range', async () => {
    const time = buildTimeContext(now(), 'Asia/Shanghai', 'any', { from: '2020-01-01', to: '2020-12-31' });
    const fetchImpl = jsonFetch({ results: [result] });
    const batch = await search(fetchImpl, { time });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ start_date: '2020-01-01', end_date: '2020-12-31' });
    expect(batch.warnings).toContain('date_filter_calendar_day_precision');
  });
  it('rejects reversed exact ranges within the same calendar day without a request', async () => {
    const fetchImpl = jsonFetch({ results: [result] });
    const batch = await search(fetchImpl, { time: { nowIso: now().toISOString(), localDate: '2026-10-01', timeZone: 'UTC', from: '2020-01-01T08:00:00Z', to: '2020-01-01T07:00:00Z' } });
    expect(batch.status).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('uses Firecrawl tbs and documented site operators without claiming item publication dates', async () => {
    const fetchImpl = jsonFetch({ data: { web: [{ title: 'T', url: result.url, description: 'S', published_time: '2026-09-30' }] } });
    const batch = await search(fetchImpl, { providerId: 'firecrawl', config: {}, action: { ...action, domains: ['example.com'], freshness: 'day' } });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ query: `${action.query} site:example.com`, limit: 5, tbs: 'qdr:d' });
    expect(batch.results[0]?.publishedAt).toBeNull();
  });
  it('uses SearXNG native day/month only and warns that engine support varies', async () => {
    const fetchImpl = jsonFetch({ results: [result] });
    const batch = await search(fetchImpl, { providerId: 'searxng', config: { baseUrl: 'https://searx.example.com' }, action: { ...action, freshness: 'day', language: 'en-US' } });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get('time_range')).toBe('day');
    expect(url.searchParams.get('language')).toBe('en-US');
    expect(batch.warnings).toContain('date_filter_engine_dependent');
    expect(batch.warnings).not.toContain('language_filter_unsupported');
  });
  it('adds bounded query hints and warnings for unsupported date/domain filters without claiming filtering', async () => {
    const fetchImpl = jsonFetch({ data: { webPages: { value: [{ name: 'T', url: result.url, summary: 'S' }] } } });
    const batch = await search(fetchImpl, { providerId: 'bocha', action: { ...action, domains: ['example.com'] } });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.query).toContain('site:example.com');
    expect(body.query).toContain('after:2026-09-24');
    expect(body).not.toHaveProperty('freshness');
    expect(batch.warnings).toEqual(expect.arrayContaining(['date_filter_unsupported', 'domain_filter_unsupported']));
  });
  it('rejects invalid domain conditions before calling a service', async () => {
    const fetchImpl = jsonFetch({ results: [result] });
    const batch = await search(fetchImpl, { action: { ...action, domains: ['example.com OR steal-policy'] } });
    expect(batch.status).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-09-30', '2026-09-30', undefined],
    ['2026-10-01T15:30:00+08:00', '2026-10-01T07:30:00.000Z', undefined],
    ['2026-10-01T09:00:00Z', null, 'publication_date_future'],
    ['not a date', null, 'publication_date_invalid'],
    ['2026-02-30', null, 'publication_date_invalid'],
    ['2026-09-30T24:00:00Z', null, 'publication_date_invalid'],
    ['2026-10-02', null, 'publication_date_future'],
    [undefined, null, 'publication_date_unknown'],
  ])('preserves true Bocha publication semantics for %s', async (datePublished, expected, warning) => {
    const batch = await search(jsonFetch({ data: { webPages: { value: [{ name: 'T', url: result.url, summary: 'S', datePublished, dateLastCrawled: '2026-10-01' }] } } }), { providerId: 'bocha' });
    expect(batch.results[0]?.publishedAt).toBe(expected);
    expect(batch.retrievedAt).toBe(now().toISOString());
    if (warning) expect(batch.warnings).toContain(warning);
    if (expected === null) expect(batch.warnings).toContain('publication_date_unknown');
  });

  it.each([
    ['2026-10-01', 'Asia/Shanghai', '2026-10-01'],
    ['2026-10-02', 'Asia/Shanghai', null],
    ['2026-10-01', undefined, null],
    ['2026-09-30', undefined, '2026-09-30'],
  ])('compares date-only %s against local calendar days (%s, UTC fallback)', async (datePublished, timeZone, expected) => {
    const localNow = () => new Date('2026-10-01T00:30:00+08:00');
    const batch = await search(jsonFetch({ data: { webPages: { value: [{ name: 'T', url: result.url, summary: 'S', datePublished }] } } }), {
      providerId: 'bocha', now: localNow,
      ...(timeZone ? { time: buildTimeContext(localNow(), timeZone, 'any') } : {}),
    });
    expect(batch.results[0]?.publishedAt).toBe(expected);
    expect(batch.retrievedAt).toBe(localNow().toISOString());
    if (expected === null) expect(batch.warnings).toEqual(expect.arrayContaining(['publication_date_future', 'publication_date_unknown']));
    else expect(batch.warnings).not.toContain('publication_date_future');
  });

  it('makes Bing two-host fallback observable and stops before fallback on cancellation', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('<html></html>'));
    const batch = await search(fetchImpl, { providerId: 'bing', config: {} });
    expect(batch.status).toBe('empty');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(batch.warnings).toEqual(expect.arrayContaining(['request_count:2', 'request_host:https://cn.bing.com', 'request_host:https://www.bing.com']));
    const user = new AbortController();
    const cancelledFetch = vi.fn<typeof fetch>(async () => { user.abort(); return new Response('<html></html>'); });
    await expect(search(cancelledFetch, { providerId: 'bing', config: {}, signal: user.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(cancelledFetch).toHaveBeenCalledTimes(1);
  });
  it('never masks permanent Bing HTTP errors with an empty fallback', async () => {
    const fetchImpl = jsonFetch({}, 401);
    expect((await search(fetchImpl, { providerId: 'bing', config: {} })).status).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('bounds transient Bing HTTP fallback to two visible requests', async () => {
    const fetchImpl = jsonFetch({}, 503);
    const batch = await search(fetchImpl, { providerId: 'bing', config: {} });
    expect(batch.status).toBe('transient');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(batch.warnings).toContain('request_count:2');
    expect(batch.warnings).toContain('search_http_status:503');
  });
  it('advertises verified content only and preserves credential hosts', () => {
    const providers = Object.fromEntries(BUILTIN_SEARCH_PROVIDERS.map((p) => [p.id, p]));
    expect(providers.firecrawl?.capabilities.content).toBe(true);
    expect(providers.tavily?.capabilities.content).toBe(false);
    expect(providers.bocha?.capabilities.publishedAt).toBe(true);
    expect(providers.bing?.capabilities).toEqual({ dateFilter: false, domainFilter: false, publishedAt: false, content: false });
    expect(providers.tavily?.hosts({})).toEqual(['https://api.tavily.com/*']);
    expect(providers.bing?.hosts({})).toEqual(['https://cn.bing.com/*', 'https://www.bing.com/*']);
  });
});
