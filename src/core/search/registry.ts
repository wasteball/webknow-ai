import { appError, type AppError } from '../errors';
import { LIMITS } from '../limits';
import type { SearchAction, SearchBatch, TimeContext } from './agent-types';
import { bingKeyless, bocha, duckduckgo, firecrawl, searxng, tavily } from './providers';
import { SearchProviderFailure, type SearchProvider, type SearchResult } from './types';

/**
 * 供应商注册表与搜索执行（产品化改造 F3）。
 * searchWithProvider 只允许 background 调用：搜索配置与 Key 一样不离开后台边界。
 *
 * 免 Key 的排在最前面：默认选择就是"开箱可用"，用户不必先有账号或实例。
 * 顺序按"可靠优先"：Firecrawl 是结构化接口，Bing / DuckDuckGo 是抓页面，
 * 但三者互为备份——任何一个被限流或网络不通时，用户都有别的可选。
 */

export const BUILTIN_SEARCH_PROVIDERS: SearchProvider[] = [
  firecrawl,
  bingKeyless,
  duckduckgo,
  searxng,
  tavily,
  bocha,
];

export function findSearchProvider(id: string): SearchProvider | undefined {
  return BUILTIN_SEARCH_PROVIDERS.find((provider) => provider.id === id);
}

/** 搜索结果作为候选，写入提示词前做结构清洗：去重、限长、限量。 */
export function cleanSearchResults(
  raw: SearchResult[],
  maxResults: number,
): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const item of raw) {
    const url = item.url.trim();
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: item.title.trim().slice(0, 200),
      url,
      snippet: item.snippet.trim().slice(0, 500),
      publishedAt: item.publishedAt ?? null,
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** 执行一次搜索：供应商不存在或配置缺失时抛出可理解的错误。 */
export async function searchWithProvider(input: {
  providerId: string;
  config: Record<string, string>;
  query: string;
  count: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<SearchResult[]> {
  const provider = findSearchProvider(input.providerId);
  if (!provider) {
    throw appError('SEARCH_FAILED', '这个搜索供应商不存在，请到设置里重新选择。', false);
  }
  try {
    const raw = await provider.search({
      query: input.query,
      count: input.count,
      signal: input.signal,
      config: input.config,
      fetchImpl: input.fetchImpl,
    });
    const cleaned = cleanSearchResults(raw, input.count);
    if (!cleaned.length) {
      throw appError('SEARCH_FAILED', '搜索没有返回可用结果。这次只用了文章本身来回答。', true);
    }
    return cleaned;
  } catch (error) {
    if (isAppError(error)) throw error;
    throw appError('SEARCH_FAILED', '联网搜索失败了。这次只用了文章本身来回答。', true);
  }
}

function isAppError(value: unknown): value is AppError {
  return typeof value === 'object' && value !== null && typeof (value as AppError).code === 'string';
}

const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type PublicationDate = { kind: 'date'; value: string } | { kind: 'instant'; timestamp: number };

function validDate(value: string): PublicationDate | null {
  // Date.parse accepts impossible dates (e.g. February 30); validate the calendar first.
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return null;
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) return null;
  // UTC above validates calendar components only; it is not a publication instant.
  if (value.length === 10) return { kind: 'date', value };
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { kind: 'instant', timestamp: parsed } : null;
}

function publicationDate(value: string | null | undefined, now: Date, timeZone: string, warn: (warning: string) => void): string | null {
  if (!value) { warn('publication_date_unknown'); return null; }
  const parsed = validDate(value);
  if (parsed === null) { warn('publication_date_invalid'); warn('publication_date_unknown'); return null; }
  const isFuture = parsed.kind === 'date'
    ? parsed.value > rangeDate(now.toISOString(), timeZone)
    : parsed.timestamp > now.getTime();
  if (isFuture) { warn('publication_date_future'); warn('publication_date_unknown'); return null; }
  return parsed.kind === 'date' ? parsed.value : new Date(parsed.timestamp).toISOString();
}

function rangeDate(value: string, timeZone: string): string {
  const parsed = validDate(value);
  if (parsed === null) throw new Error('Invalid search range');
  if (parsed.kind === 'date') return parsed.value;
  // Native date APIs are calendar-day filters: preserve the gate's timezone date,
  // then report loss of exact instant precision rather than silently shifting a day.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(parsed.timestamp));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Research contract: no retries here. The runner owns the shared five-action limit. */
export async function researchSearch(input: {
  providerId: string;
  config: Record<string, string>;
  action: SearchAction;
  signal: AbortSignal;
  now: () => Date;
  fetchImpl?: typeof fetch;
  time?: TimeContext;
}): Promise<SearchBatch> {
  if (input.signal.aborted) throw appError('ABORTED', '已经停止。');
  const retrieved = input.now();
  const warnings = new Set<string>();
  const warn = (warning: string) => { warnings.add(warning); };
  const provider = findSearchProvider(input.providerId);
  let requests = 0;
  const batch = (status: SearchBatch['status'], results: SearchResult[] = []): SearchBatch => {
    if (provider?.id === 'bing') warn(`request_count:${requests}`);
    return { status, results, provider: provider?.id ?? input.providerId, retrievedAt: retrieved.toISOString(), warnings: [...warnings] };
  };
  if (!provider) { warn('provider_unknown'); return batch('failed'); }
  const timeout = AbortSignal.timeout(LIMITS.searchTimeoutMs);
  const combined = AbortSignal.any([input.signal, timeout]);
  try {
    // Copy only known action fields; extra article/history/policy fields can never be serialized.
    const domains = [...new Set(input.action.domains.map((domain) => domain.trim().toLowerCase()))];
    if (domains.length > 5 || domains.some((domain) => domain.length > 253 || !hostname.test(domain))) {
      warn('domain_filter_invalid'); return batch('failed');
    }
    if (!Number.isInteger(input.action.maxResults) || input.action.maxResults < 1 || input.action.maxResults > 10
      || !input.action.query.trim() || input.action.query.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(input.action.query)
      || !/^[a-zA-Z0-9-]{1,40}$/.test(input.action.language)) {
      warn('search_conditions_invalid'); return batch('failed');
    }
    let query = input.action.query.trim();
    if (!['searxng', 'bing'].includes(provider.id)) warn('language_filter_unsupported');
    const hasRange = Boolean(input.time?.from || input.time?.to);
    let time: TimeContext | undefined;
    if (hasRange) {
      if (input.time!.from && input.time!.to && Date.parse(input.time!.from) > Date.parse(input.time!.to)) {
        throw new Error('Invalid search range');
      }
      time = {
        nowIso: input.time!.nowIso, localDate: input.time!.localDate, timeZone: input.time!.timeZone,
        ...(input.time!.from ? { from: rangeDate(input.time!.from, input.time!.timeZone) } : {}),
        ...(input.time!.to ? { to: rangeDate(input.time!.to, input.time!.timeZone) } : {}),
      };
      if (time.from && time.to && time.from > time.to) throw new Error('Invalid search range');
      warn('date_filter_calendar_day_precision');
      if (provider.id !== 'tavily') {
        query += `${time.from ? ` after:${time.from}` : ''}${time.to ? ` before:${time.to}` : ''}`;
        warn('date_range_query_hint');
      }
    } else if (input.action.freshness !== 'any') {
      const dateSupported = provider.capabilities.dateFilter && !(provider.id === 'searxng' && input.action.freshness === 'week');
      if (!dateSupported) {
        const days = { live: 1, day: 1, week: 7, month: 30 }[input.action.freshness];
        query += ` after:${new Date(retrieved.getTime() - days * 86_400_000).toISOString().slice(0, 10)}`;
        warn('date_filter_unsupported');
      }
      if (input.action.freshness === 'live') warn('live_filter_day_resolution');
    }
    if (provider.id === 'tavily' && (hasRange || input.action.freshness !== 'any')) warn('date_filter_publication_or_update');
    if (provider.id === 'searxng' && !hasRange && ['day', 'live', 'month'].includes(input.action.freshness)) warn('date_filter_engine_dependent');
    if (domains.length && !provider.capabilities.domainFilter) {
      const sites = domains.map((domain) => `site:${domain}`);
      query += ` ${sites.length === 1 ? sites[0] : `(${sites.join(' OR ')})`}`;
      warn('domain_filter_unsupported');
    }
    const fetchImpl: typeof fetch = async (url, init) => {
      combined.throwIfAborted();
      requests++;
      if (provider.id === 'bing') warn(`request_host:${new URL(String(url)).origin}`);
      try { return await (input.fetchImpl ?? fetch)(url, init); }
      catch { throw new SearchProviderFailure('搜索网络请求失败', 'network'); }
    };
    const raw = await provider.search({
      query, count: input.action.maxResults, config: input.config, signal: combined,
      purpose: input.action.purpose, freshness: input.action.freshness,
      language: input.action.language, domains: provider.capabilities.domainFilter ? domains : [], time, fetchImpl,
    });
    if (input.signal.aborted) throw appError('ABORTED', '已经停止。');
    combined.throwIfAborted();
    const results = cleanSearchResults(raw, input.action.maxResults).map((item) => ({
      // Date-only publication precision is retained; absent program TimeContext
      // explicitly falls back to UTC calendar days, never machine-local timezone.
      ...item, publishedAt: publicationDate(item.publishedAt, retrieved, input.time?.timeZone ?? 'UTC', warn),
    }));
    return batch(results.length ? 'ok' : 'empty', results);
  } catch (error) {
    // User cancellation takes priority over simultaneous timeout or a late network response.
    if (input.signal.aborted) throw appError('ABORTED', '已经停止。');
    if (timeout.aborted) { warn('search_timeout'); return batch('transient'); }
    if (error instanceof SearchProviderFailure) {
      if (error.kind === 'network') { warn('search_network_failure'); return batch('transient'); }
      if (error.kind === 'http') {
        warn(`search_http_status:${error.status}`);
        return batch(error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500 ? 'transient' : 'failed');
      }
    }
    warn('search_response_or_configuration_invalid');
    return batch('failed');
  }
}
