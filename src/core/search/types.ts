/**
 * 联网搜索的供应商接口（产品化改造 F3）。
 *
 * 首版的“插件化”：加一个搜索供应商 = 在 providers/ 加一个文件并注册进 BUILTIN_PROVIDERS，
 * 不改流水线。远程插件市场不做；供应商实现只在 background 被调用，配置（Key 等）
 * 与站点凭证一样不进界面、提示词或日志。
 *
 * 所有供应商都必须把网页结果当作不可信数据处理：标题与摘要会进提示词，
 * 但永远不能被当作“作者原话”（引用只来自本地正文块，见 answer 提示词的固定纪律）。
 */

export type SearchProviderConfigField = {
  key: string;
  label: string;
  type: 'password' | 'text' | 'url';
  required: boolean;
  placeholder?: string;
};

export type SearchResult = { title: string; url: string; snippet: string };

export type SearchRequest = {
  query: string;
  count: number;
  signal: AbortSignal;
  /** 该供应商的配置（apiKey / baseUrl 等）。 */
  config: Record<string, string>;
  fetchImpl?: typeof fetch;
};

export type SearchProvider = {
  id: string;
  name: string;
  description: string;
  /** 启用该供应商需要向用户申请的 host 权限（根据配置计算）。 */
  hosts: (config: Record<string, string>) => string[];
  configFields: SearchProviderConfigField[];
  search: (request: SearchRequest) => Promise<SearchResult[]>;
};

export function originOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}
