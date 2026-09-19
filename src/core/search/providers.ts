import type { SearchProvider, SearchResult } from './types';

/**
 * 搜索供应商。两类：
 *
 * 免 Key（抓公开搜索页，开箱可用，不用注册也不用自建）：
 * - Bing：cn.bing.com 主用、www.bing.com 兜底（两者页面结构一致，换 host 即可）；
 * - DuckDuckGo：html.duckduckgo.com。
 * 这类实现抓的是对方给浏览器看的页面，**对方改版就会失效**，且高频会被限流。
 * 失效时的表现是"抽不到结果"，由 registry 统一归一为 SEARCH_FAILED，
 * 界面照实说"这次只依据文章本身回答"，不会污染正文依据。
 *
 * 自备服务（稳定、合法，但要用户自己有账号或实例）：
 * - SearXNG：自建或公开实例（JSON 接口需实例开启）；
 * - Tavily：面向 LLM 的搜索 API；
 * - 博查 Bocha：国内可用的网页搜索 API。
 *
 * 搜索与模型供应商完全解耦：这里只产出 SearchResult[]，由 runner 以文本注入提示词，
 * 换任何模型都不影响这一层。
 */

/** 把一段 HTML 片段还原成纯文本：搜索结果要进提示词，不能带标记进去。 */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(input: string): string {
  return input
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:lt|#60);/gi, '<')
    .replace(/&(?:gt|#62);/gi, '>')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&nbsp;|&#160;/gi, ' ');
}

/** 取出标签里的某个属性值（属性顺序不固定，所以单独找）。 */
function attr(tag: string, name: string): string | undefined {
  const found = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return found?.[1] !== undefined ? decodeEntities(found[1]) : undefined;
}

/**
 * DuckDuckGo 的结果链接是跳转地址（`//duckduckgo.com/l/?uddg=<编码后的目标>`），
 * 要还原成真实目标；还原不出来就原样返回，交给下游的 http(s) 过滤。
 */
function unwrapRedirect(href: string): string {
  const absolute = href.startsWith('//') ? `https:${href}` : href;
  try {
    const url = new URL(absolute, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') ?? absolute;
  } catch {
    return absolute;
  }
}

/** 按出现顺序把「标题链接」与「摘要」两串配对：两类页面都是同序一一对应。 */
function zipResults(titles: { title: string; url: string }[], snippets: string[]): SearchResult[] {
  return titles.map((item, index) => ({ ...item, snippet: snippets[index] ?? '' }));
}

function pickString(value: unknown, path: (string | number)[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function pickArray(value: unknown, path: (string | number)[]): unknown[] | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return Array.isArray(current) ? current : undefined;
}

export const searxng: SearchProvider = {
  id: 'searxng',
  name: 'SearXNG（自建或公开实例）',
  description: '开源聚合搜索，不需要 Key；填你的实例地址，实例需开启 JSON 输出。',
  configFields: [
    {
      key: 'baseUrl',
      label: '实例地址',
      type: 'url',
      required: true,
      placeholder: 'https://你的实例.example.com',
    },
  ],
  hosts: (config) => {
    const base = config.baseUrl?.trim().replace(/\/+$/, '');
    return base ? [`${new URL(base).origin}/*`] : [];
  },
  async search(request) {
    const base = request.config.baseUrl?.trim().replace(/\/+$/, '');
    if (!base) throw new Error('SearXNG 缺少实例地址');
    const doFetch = request.fetchImpl ?? fetch;
    const url = `${base}/search?q=${encodeURIComponent(request.query)}&format=json&language=zh-CN`;
    const response = await doFetch(url, {
      headers: { Accept: 'application/json' },
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`SearXNG 返回 ${response.status}（实例可能未开启 JSON 输出）`);
    const payload: unknown = await response.json();
    const entries = pickArray(payload, ['results']) ?? [];
    return entries
      .map((entry) => ({
        title: pickString(entry, ['title']) ?? '',
        url: pickString(entry, ['url']) ?? '',
        snippet: pickString(entry, ['content']) ?? '',
      }))
      .filter((item): item is SearchResult => Boolean(item.url && item.title));
  },
};

export const tavily: SearchProvider = {
  id: 'tavily',
  name: 'Tavily',
  description: '面向 AI 的搜索接口，需要自己的 API Key（有免费额度）。',
  configFields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'tvly-...' },
  ],
  hosts: () => ['https://api.tavily.com/*'],
  async search(request) {
    const apiKey = request.config.apiKey?.trim();
    if (!apiKey) throw new Error('Tavily 缺少 API Key');
    const doFetch = request.fetchImpl ?? fetch;
    const response = await doFetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: request.query, max_results: request.count, search_depth: 'basic' }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`Tavily 返回 ${response.status}`);
    const payload: unknown = await response.json();
    const entries = pickArray(payload, ['results']) ?? [];
    return entries
      .map((entry) => ({
        title: pickString(entry, ['title']) ?? '',
        url: pickString(entry, ['url']) ?? '',
        snippet: pickString(entry, ['content']) ?? '',
      }))
      .filter((item): item is SearchResult => Boolean(item.url && item.title));
  },
};

/**
 * 免 Key：抓 Bing 的结果页。两个 host 页面结构相同，主用国内可达的 cn.bing.com。
 * 结果块是 `<li class="b_algo">`，块内第一个 <h2> 里的链接是标题（Bing 的 <h2> 里
 * 还可能套一层别的标记，所以不要求 <a> 紧跟其后）。
 */
export const bingKeyless: SearchProvider = {
  id: 'bing',
  name: 'Bing',
  description: '直接用 Bing 的结果页，不用注册也不用填 Key。国内网络可用；对方改版可能失效。',
  configFields: [],
  hosts: () => ['https://cn.bing.com/*', 'https://www.bing.com/*'],
  async search(request) {
    const doFetch = request.fetchImpl ?? fetch;
    for (const host of ['https://cn.bing.com', 'https://www.bing.com']) {
      const url = `${host}/search?q=${encodeURIComponent(request.query)}&setlang=zh-CN`;
      const response = await doFetch(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: request.signal,
      });
      if (!response.ok) continue;
      const results = parseBing(await response.text(), request.count);
      // 第一个 host 抽不到就换第二个；都抽不到才交给上游降级。
      if (results.length) return results;
    }
    throw new Error('Bing 没有返回可解析的结果（页面结构可能变了）');
  },
};

function parseBing(html: string, count: number): SearchResult[] {
  const titles: { title: string; url: string }[] = [];
  const snippets: string[] = [];
  const blocks = html.split(/<li[^>]+class="[^"]*b_algo[^"]*"/i).slice(1);
  for (const block of blocks) {
    const heading = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1];
    const anchor = heading ? /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading) : null;
    if (!anchor) continue;
    const url = attr(anchor[1]!, 'href');
    const title = textOf(anchor[2]!);
    if (!url || !title) continue;
    titles.push({ title, url });
    snippets.push(textOf(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? ''));
    if (titles.length >= count) break;
  }
  return zipResults(titles, snippets);
}

/**
 * 免 Key：抓 DuckDuckGo 的无脚本结果页。链接是跳转地址，需要还原。
 * 这是海外网络的备选——大陆直连通常不可达。
 */
export const duckduckgo: SearchProvider = {
  id: 'duckduckgo',
  name: 'DuckDuckGo',
  description: '直接用 DuckDuckGo 的结果页，不用注册也不用填 Key。海外网络可用；对方改版可能失效。',
  configFields: [],
  hosts: () => ['https://html.duckduckgo.com/*'],
  async search(request) {
    const doFetch = request.fetchImpl ?? fetch;
    const response = await doFetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`,
      { headers: { Accept: 'text/html' }, signal: request.signal },
    );
    if (!response.ok) throw new Error(`DuckDuckGo 返回 ${response.status}`);
    return parseDuckDuckGo(await response.text(), request.count);
  },
};

function parseDuckDuckGo(html: string, count: number): SearchResult[] {
  const titles: { title: string; url: string }[] = [];
  const snippets: string[] = [];
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchors)) {
    const attributes = match[1]!;
    if (!/class\s*=\s*"[^"]*result__a/i.test(attributes)) continue;
    const href = attr(attributes, 'href');
    const title = textOf(match[2]!);
    if (!href || !title) continue;
    titles.push({ title, url: unwrapRedirect(href) });
    if (titles.length >= count) break;
  }
  const snippetRe = /<a\b([^>]*class\s*=\s*"[^"]*result__snippet[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(snippetRe)) snippets.push(textOf(match[2]!));
  return zipResults(titles, snippets);
}

/**
 * 免 Key：Firecrawl 的匿名搜索接口（`POST /v2/search`，不带 Authorization 即可用）。
 *
 * 这是 dsh 插件 @liustack/modsearch 在"免费、无需注册"那条路径上用的同一个后端——
 * 那个插件本身是 Node CLI，浏览器扩展装不了，但它的后端可以直接调用。
 * 比抓搜索页好在：返回结构化 JSON，不用解析 HTML，对方改版也不会突然失效。
 * 匿名额度是有限且可能被限流的（实测连打 6 次都正常，但这不是保证），
 * 失败时照常走"只依据文章本身回答"的降级路径。
 */
export const firecrawl: SearchProvider = {
  id: 'firecrawl',
  name: 'Firecrawl',
  description: '面向 agent 的搜索接口，匿名可用——不用注册、不用填 Key，直接返回结构化结果。',
  configFields: [],
  hosts: () => ['https://api.firecrawl.dev/*'],
  async search(request) {
    const doFetch = request.fetchImpl ?? fetch;
    const response = await doFetch('https://api.firecrawl.dev/v2/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: request.query, limit: request.count }),
      signal: request.signal,
    });
    if (!response.ok) {
      throw new Error(`Firecrawl 返回 ${response.status}（匿名额度可能已被限流）`);
    }
    const payload: unknown = await response.json();
    const entries = pickArray(payload, ['data', 'web']) ?? [];
    return entries
      .map((entry) => ({
        title: pickString(entry, ['title']) ?? '',
        url: pickString(entry, ['url']) ?? '',
        snippet: pickString(entry, ['description']) ?? '',
      }))
      .filter((item): item is SearchResult => Boolean(item.url && item.title));
  },
};

export const bocha: SearchProvider = {
  id: 'bocha',
  name: '博查 Bocha',
  description: '国内可用的网页搜索 API，需要自己的 API Key（按量计费）。',
  configFields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'sk-...' },
  ],
  hosts: () => ['https://api.bochaai.com/*'],
  async search(request) {
    const apiKey = request.config.apiKey?.trim();
    if (!apiKey) throw new Error('博查缺少 API Key');
    const doFetch = request.fetchImpl ?? fetch;
    const response = await doFetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: request.query, summary: true, count: request.count }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`博查返回 ${response.status}`);
    const payload: unknown = await response.json();
    const entries = pickArray(payload, ['data', 'webPages', 'value']) ?? [];
    return entries
      .map((entry) => ({
        title: pickString(entry, ['name']) ?? '',
        url: pickString(entry, ['url']) ?? '',
        snippet: pickString(entry, ['summary']) ?? pickString(entry, ['snippet']) ?? '',
      }))
      .filter((item): item is SearchResult => Boolean(item.url && item.title));
  },
};
