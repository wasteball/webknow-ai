import { appError, type AppError } from '../errors';

/**
 * 腾讯 ima OpenAPI 客户端（K-ima，2026-09-19）。
 *
 * 接入面来自官方开放接口的社区实测（ABccgh/dsh-ima-kb 等），关键事实：
 * - Base URL `https://ima.qq.com`，HTTPS POST JSON；
 * - 鉴权双头 `ima-openapi-clientid` + `ima-openapi-apikey`（ima.qq.com/agent-interface 生成）；
 * - 业务失败包络有两种：`{code,msg}` 与 `{retcode,errmsg}`，都必须识别；
 * - `import_urls` 对同一 URL 幂等（返回相同 media_id）；开放接口没有删除能力；
 * - `import_urls` 需要 `folder_id`，且根目录 id ≠ 知识库 id，要从 get_knowledge_list 解析。
 *
 * 本模块只被 background 调用：凭证与站点内容一样不进界面、日志或提示词。
 */

export const IMA_BASE_URL = 'https://ima.qq.com';
const WIKI = '/openapi/wiki/v1';
const NOTE = '/openapi/note/v1';

export type ImaKnowledgeBase = { id: string; name: string; contentCount: number };

export type ImaCredentials = { clientId: string; apiKey: string };

export type ImaFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 把 ima 的失败翻译成产品错误；上游文案本身是中文且可执行，如实保留。 */
export function toImaAppError(error: unknown): AppError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as AppError;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') return candidate;
  }
  return appError('IMA_FAILED', '联系知识库服务失败了。可以稍后再试。', true);
}

export class ImaClient {
  private readonly clientId: string;
  private readonly apiKey: string;
  private readonly fetchImpl: ImaFetch;
  private readonly timeoutMs: number;

  constructor(options: { credentials: ImaCredentials; fetchImpl?: ImaFetch; timeoutMs?: number }) {
    this.clientId = options.credentials.clientId.trim();
    this.apiKey = options.credentials.apiKey.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** POST 一个 JSON 体并解包；业务失败抛出带上游文案的产品错误。 */
  async call<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${IMA_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'ima-openapi-clientid': this.clientId,
          'ima-openapi-apikey': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: timeout,
      });
    } catch {
      if (timeout.aborted) {
        throw appError('IMA_FAILED', '知识库服务等太久没有回应。可以稍后再试。', true);
      }
      throw appError('IMA_FAILED', '连不上知识库服务。请检查网络后重试。', true);
    }

    if (response.status === 401 || response.status === 403) {
      throw appError('IMA_FAILED', '知识库服务拒绝了凭证。请到设置里检查 Client ID 和 API Key。', false);
    }
    if (!response.ok) {
      throw appError('IMA_FAILED', `知识库服务返回了异常状态（${response.status}）。可以稍后再试。`, true);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw appError('IMA_FAILED', '知识库服务返回了无法解析的内容。可以稍后再试。', true);
    }
    if (payload === null || typeof payload !== 'object') {
      throw appError('IMA_FAILED', '知识库服务返回了无法解析的内容。可以稍后再试。', true);
    }
    const record = payload as Record<string, unknown>;
    const code = record.code ?? record.retcode;
    if (code !== 0) {
      const message = typeof record.msg === 'string' ? record.msg : typeof record.errmsg === 'string' ? record.errmsg : '未知错误';
      throw appError('IMA_FAILED', `知识库操作没有成功（${code}）：${message}`, code === 110010 || code === 110021);
    }
    return (record.data ?? {}) as T;
  }

  /** 列出可访问的知识库（连接测试与默认库选择都用它）。 */
  async listKnowledgeBases(query = ''): Promise<ImaKnowledgeBase[]> {
    const data = await this.call<{ info_list?: unknown }>('/openapi/wiki/v1/search_knowledge_base', {
      query,
      cursor: '',
      limit: 20,
    });
    const list = Array.isArray(data.info_list) ? data.info_list : [];
    return list
      .map((entry) => {
        const item = entry as Record<string, unknown>;
        const id = typeof item.kb_id === 'string' ? item.kb_id : typeof item.id === 'string' ? item.id : '';
        const name = typeof item.kb_name === 'string' ? item.kb_name : typeof item.name === 'string' ? item.name : '';
        if (!id || !name) return null;
        return {
          id,
          name,
          contentCount: Number(item.content_count ?? 0),
        } satisfies ImaKnowledgeBase;
      })
      .filter((item): item is ImaKnowledgeBase => item !== null);
  }

  /**
   * 解析知识库根目录 id。实测根目录 `folder_id` ≠ `knowledge_base_id`，
   * 必须从 get_knowledge_list 的 current_path 里取，直接拿知识库 id 会被拒绝。
   */
  async resolveRootFolder(knowledgeBaseId: string): Promise<string> {
    const data = await this.call<{ current_path?: unknown }>('/openapi/wiki/v1/get_knowledge_list', {
      knowledge_base_id: knowledgeBaseId,
      cursor: '',
      limit: 1,
    });
    const path = Array.isArray(data.current_path) ? data.current_path : [];
    const first = path[0] as Record<string, unknown> | undefined;
    const folderId = typeof first?.folder_id === 'string' ? first.folder_id : '';
    if (!folderId) {
      throw appError('IMA_FAILED', '没能定位知识库的根目录。请到 ima 客户端确认这个知识库可用。', false);
    }
    return folderId;
  }

  /** 把网页 URL 导入知识库（同一 URL 幂等，ima 自行抓取解析）。 */
  async importUrls(knowledgeBaseId: string, folderId: string, urls: string[]): Promise<void> {
    await this.call('/openapi/wiki/v1/import_urls', {
      knowledge_base_id: knowledgeBaseId,
      folder_id: folderId,
      urls,
    });
  }

  /** 写一条 Markdown 笔记（content_format 1 = Markdown），返回笔记 id。 */
  async importDoc(title: string, markdown: string): Promise<string> {
    const data = await this.call<{ doc_id?: unknown }>('/openapi/note/v1/import_doc', {
      content: markdown,
      content_format: 1,
      title,
    });
    return typeof data.doc_id === 'string' ? data.doc_id : '';
  }
}
