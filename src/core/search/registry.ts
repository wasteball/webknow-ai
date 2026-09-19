import { appError, type AppError } from '../errors';
import { bingKeyless, bocha, duckduckgo, firecrawl, searxng, tavily } from './providers';
import type { SearchProvider, SearchResult } from './types';

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
