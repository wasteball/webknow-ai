import type { SearchProvider, SearchResult } from './types';

/**
 * 首发供应商（产品化改造 F3）。三个各覆盖一种接入形态：
 * - SearXNG：自建或公开实例，无需 Key（JSON 接口需实例开启）；
 * - Tavily：面向 LLM 的搜索 API（海外）；
 * - 博查 Bocha：国内可用的网页搜索 API。
 */

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
