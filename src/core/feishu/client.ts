import { appError, type AppError } from '../errors';

/**
 * 飞书知识库客户端（四期，2026-11-08）。接入面来自飞书开放平台官方文档：
 * - 应用凭证：POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
 *   body {app_id, app_secret} → {code, tenant_access_token, expire}（最长 2 小时）。
 *   官方另有新版 accounts.feishu.cn/oauth/v3/token（JWT）；旧版仍在文档中且可用，先用旧版，只多一个站点权限。
 * - 知识空间列表：GET /open-apis/wiki/v2/spaces?page_size≤50&page_token → data.items[{space_id,name}], has_more。
 *   应用必须被加为知识空间成员，否则列表为空。权限 wiki:space:retrieve / wiki:wiki。
 * - 建节点：POST /open-apis/wiki/v2/spaces/:space_id/nodes {obj_type:'docx', node_type:'origin', title}
 *   → data.node.{node_token, obj_token}。权限 wiki:node:create / wiki:wiki。
 * - 写内容：POST /open-apis/docx/v1/documents/:document_id/blocks/:block_id/children
 *   {index:-1, children[1..50]}；文档根块 id = document_id。权限 docx:document。应用每秒 3 次。
 *
 * 只被 background 调用：App Secret 与访问凭证不进界面、日志、提示词或笔记。
 */

export const FEISHU_BASE_URL = 'https://open.feishu.cn';
export const FEISHU_ORIGIN = 'https://open.feishu.cn/*';

export type FeishuCredentials = { appId: string; appSecret: string };
export type FeishuSpace = { id: string; name: string };
export type FeishuFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 每次写入最多 50 个子块（官方数据校验规则）。 */
const MAX_CHILDREN = 50;

/** 常见错误码 → 人话。 */
const KNOWN: Record<number, string> = {
  10003: '飞书说应用凭证的格式不对。请到设置里检查 App ID 和 App Secret。',
  10014: '飞书说 App Secret 不对。请到设置里检查。',
  20048: '飞书说没有这个应用。请检查 App ID。',
  99991663: '飞书的访问凭证失效了，再试一次即可。',
  99991672: '这个飞书应用还没开通需要的权限。请在开发者后台开通“查看、编辑和管理知识库”和“创建及编辑新版文档”，并发布版本。',
  131006: '飞书应用没有这个知识库的编辑权限。请把应用加为这个知识库的成员（可编辑）。',
  131005: '没找到这个知识库，可能已被删除。请到设置里重新选择。',
  99991400: '飞书限制了请求频率，过一会儿再试。',
};

export function toFeishuAppError(error: unknown): AppError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as AppError;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') return candidate;
  }
  return appError('IMA_FAILED', '联系飞书失败了。可以稍后再试。', true);
}

export class FeishuClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly fetchImpl: FeishuFetch;
  private readonly timeoutMs: number;
  private token: { value: string; until: number } | null = null;

  constructor(options: { credentials: FeishuCredentials; fetchImpl?: FeishuFetch; timeoutMs?: number }) {
    this.appId = options.credentials.appId.trim();
    this.appSecret = options.credentials.appSecret.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request(path: string, init: { method: 'GET' | 'POST'; body?: unknown; auth?: boolean }): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    if (init.auth !== false) headers.authorization = `Bearer ${await this.accessToken()}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${FEISHU_BASE_URL}${path}`, {
        method: init.method, headers, signal: timeout,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      if (timeout.aborted) throw appError('IMA_FAILED', '飞书等太久没有回应。可以稍后再试。', true);
      throw appError('IMA_FAILED', '连不上飞书。请检查网络后重试。', true);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw appError('IMA_FAILED', `飞书返回了异常状态（${response.status}）。可以稍后再试。`, true);
    }
    const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const code = typeof record.code === 'number' ? record.code : response.ok ? 0 : -1;
    if (code !== 0) {
      const message = KNOWN[code] ?? `飞书操作没有成功（${code}）：${typeof record.msg === 'string' ? record.msg : '未知错误'}`;
      throw appError('IMA_FAILED', message, code === 99991400 || code === 99991663 || code === 131009);
    }
    return record;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const record = await this.request('/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', auth: false, body: { app_id: this.appId, app_secret: this.appSecret },
    });
    const value = typeof record.tenant_access_token === 'string' ? record.tenant_access_token : '';
    if (!value) throw appError('IMA_FAILED', '飞书没有给出访问凭证。请检查 App ID 和 App Secret。', false);
    const expire = typeof record.expire === 'number' ? record.expire : 3600;
    // 提前 5 分钟换新，不在临界点上用快过期的凭证。
    this.token = { value, until: Date.now() + Math.max(60, expire - 300) * 1000 };
    return value;
  }

  /** 应用能访问的知识空间（连接测试与默认空间选择都用它）。 */
  async listSpaces(): Promise<FeishuSpace[]> {
    const spaces: FeishuSpace[] = [];
    let pageToken = '';
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ page_size: '50', ...(pageToken ? { page_token: pageToken } : {}) });
      const record = await this.request(`/open-apis/wiki/v2/spaces?${query}`, { method: 'GET' });
      const data = (record.data ?? {}) as { items?: unknown; has_more?: unknown; page_token?: unknown };
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const space = item as { space_id?: unknown; name?: unknown };
        if (typeof space.space_id === 'string') spaces.push({ id: space.space_id, name: typeof space.name === 'string' ? space.name : space.space_id });
      }
      if (data.has_more !== true || typeof data.page_token !== 'string' || !data.page_token) break;
      pageToken = data.page_token;
    }
    return spaces;
  }

  /** 在知识空间顶层新建一篇文档，返回文档 id 与节点 token。 */
  async createDoc(spaceId: string, title: string): Promise<{ documentId: string; nodeToken: string }> {
    const record = await this.request(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      method: 'POST', body: { obj_type: 'docx', node_type: 'origin', title: title.slice(0, 200) },
    });
    const node = ((record.data ?? {}) as { node?: { obj_token?: unknown; node_token?: unknown } }).node;
    const documentId = typeof node?.obj_token === 'string' ? node.obj_token : '';
    if (!documentId) throw appError('IMA_FAILED', '飞书没有返回新文档。可以稍后再试。', true);
    return { documentId, nodeToken: typeof node?.node_token === 'string' ? node.node_token : '' };
  }

  /** 把块追加到文档末尾；按每次 50 个分批。 */
  async appendBlocks(documentId: string, blocks: FeishuBlock[]): Promise<void> {
    const path = `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`;
    for (let start = 0; start < blocks.length; start += MAX_CHILDREN) {
      await this.request(path, { method: 'POST', body: { index: -1, children: blocks.slice(start, start + MAX_CHILDREN) } });
    }
  }
}

export type FeishuBlock = Record<string, unknown> & { block_type: number };

const run = (content: string, bold = false) => ({ text_run: { content, ...(bold ? { text_element_style: { bold: true } } : {}) } });
const textOf = (content: string, bold = false) => ({ elements: [run(content, bold)], style: {} });

/**
 * 把阅读笔记（core/ima/note.ts 生成的受控 Markdown）转成飞书文档块。
 * 只认这份笔记会用到的几种写法：# / ## 标题、> 引用行、- 列表、**问：…** 加粗行、普通段落。
 */
export function noteToBlocks(markdown: string): FeishuBlock[] {
  const blocks: FeishuBlock[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith('# ')) continue; // 一级标题就是文档标题，不重复
    if (line.startsWith('## ')) blocks.push({ block_type: 4, heading2: textOf(line.slice(3).trim()) });
    else if (line.startsWith('> ')) blocks.push({ block_type: 15, quote: textOf(line.slice(2).trim()) });
    else if (line.startsWith('- ')) blocks.push({ block_type: 12, bullet: textOf(line.slice(2).trim()) });
    else if (/^\*\*.+\*\*$/.test(line)) blocks.push({ block_type: 2, text: textOf(line.slice(2, -2), true) });
    else blocks.push({ block_type: 2, text: textOf(line.replaceAll('**', '')) });
  }
  return blocks;
}
