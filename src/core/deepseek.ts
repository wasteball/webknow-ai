import { appError, fromHttpStatus, fromNetworkFailure } from './errors';
import { LIMITS } from './limits';

/**
 * DeepSeek 是首版唯一允许的外发目标（FR-019）。
 * 本模块只负责“把一次请求变成一段文本”，不接触会话状态；它由 background 调用，
 * 是唯一读取 Key 的地方（FR-032）。
 *
 * A0 未实测前不冻结契约（PRD 第 9 节）：
 * - DEEPSEEK_MODEL 按 2026-09 官方文档记录（deepseek-chat/deepseek-reasoner 已于 2026-07-24 停用）。
 * - 不发送任何供应商特有的采样/思考参数；先用最小可验证载荷，实测后再决定。
 */

export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-flash';

/**
 * A0 实测（2026-09-18，真实 Key）：
 * - `deepseek-flash` 默认开启思考，每个分片同时带 reasoning_content 与 content；
 *   思考文本会占用 max_tokens 预算，实测同一请求思考 1325～2697 字符。
 * - 显式关闭思考被接受，且同一请求从 3.4s 降到 1.7s，摘要与气泡质量无可见下降。
 * - `response_format: {"type":"json_object"}` 与流式同时可用。
 * 因此首版固定关闭思考：本产品的三类请求都是短结构化输出，不需要长链推理。
 */
export const DEEPSEEK_BODY_DEFAULTS = {
  response_format: { type: 'json_object' },
  thinking: { type: 'disabled' },
} as const;

export type Message = { role: 'system' | 'user'; content: string };

export type ChatOptions = {
  apiKey: string;
  messages: Message[];
  signal: AbortSignal;
  /** 已生成字符数，用于让界面与 service worker 保持活跃；不含正文内容。 */
  onProgress?: (chars: number) => void;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

/** 从 SSE 文本流中取出增量内容；跨 chunk 的半行由内部缓冲处理。 */
export function createSseReader() {
  let buffer = '';
  const state = { finishReason: '' };
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      return readDeltas(lines, state);
    },
    /** 流结束时处理残留的最后一行。 */
    flush(): string[] {
      const rest = buffer;
      buffer = '';
      return readDeltas([rest], state);
    },
    /** 结束原因：'length' 表示被输出上限截断，不得当作完整结果（FR-018）。 */
    finishReason(): string {
      return state.finishReason;
    },
  };
}

function readDeltas(lines: string[], state: { finishReason: string }): string[] {
  const deltas: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed: unknown = JSON.parse(data);
      const delta = pickString(parsed, ['choices', 0, 'delta', 'content']);
      if (delta) deltas.push(delta);
      const finish = pickString(parsed, ['choices', 0, 'finish_reason']);
      if (finish) state.finishReason = finish;
    } catch {
      // 半行、保活帧或非 JSON 数据一律忽略；最终输出校验会兜底。
    }
  }
  return deltas;
}

function pickString(value: unknown, path: (string | number)[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

/** 模型偶尔会包上代码块或前后缀；这里只做容忍解析，不做猜测性修补。 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * 发起一次请求并返回解析后的 JSON。
 * 取消、超时、HTTP 错误和网络失败都归一成 AppError，不把原始响应正文带进界面或日志。
 */
export async function chatJson(options: ChatOptions): Promise<unknown> {
  const { apiKey, messages, signal, onProgress } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(LIMITS.requestTimeoutMs);
  const combined = AbortSignal.any([signal, timeout]);

  let response: Response;
  try {
    response = await doFetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        stream: true,
        max_tokens: options.maxTokens ?? LIMITS.maxOutputTokens,
        ...DEEPSEEK_BODY_DEFAULTS,
      }),
      signal: combined,
    });
  } catch {
    if (signal.aborted) throw appError('ABORTED', '已停止本次处理。');
    if (timeout.aborted) {
      throw appError('TIMEOUT', 'DeepSeek 在限定时间内没有返回结果，本次结果未采用。可重试。', true);
    }
    throw fromNetworkFailure(globalThis.navigator?.onLine === false ? 'offline' : 'unknown');
  }

  if (!response.ok) {
    throw fromHttpStatus(response.status);
  }
  if (!response.body) {
    throw appError('SERVICE', 'DeepSeek 返回了空响应，本次结果未采用。可重试。', true);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = createSseReader();
  let text = '';
  let lastReported = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const delta of sse.push(decoder.decode(value, { stream: true }))) {
        text += delta;
      }
      if (onProgress && text.length - lastReported >= 200) {
        lastReported = text.length;
        onProgress(text.length);
      }
    }
    for (const delta of sse.flush()) text += delta;
  } catch {
    if (signal.aborted) throw appError('ABORTED', '已停止本次处理。');
    if (timeout.aborted) {
      throw appError('TIMEOUT', 'DeepSeek 响应中断，本次结果未采用。可重试。', true);
    }
    throw appError('SERVICE', '读取 DeepSeek 响应失败，本次结果未采用。可重试。', true);
  } finally {
    reader.releaseLock();
  }

  onProgress?.(text.length);
  if (sse.finishReason() === 'length') {
    // 截断必须如实说明，不能把半截 JSON 当成完整结果（FR-018）。
    throw appError(
      'BAD_OUTPUT',
      '模型输出达到长度上限被截断，本次结果未采用，也没有当作完整结果展示。可重试，或在设置中改用更短的页面。',
      true,
    );
  }
  const parsed = parseJsonLoose(text);
  if (parsed === undefined) {
    throw appError('BAD_OUTPUT', '模型返回的内容不是可用的结构化结果，本次结果未采用。可重试。', true);
  }
  return parsed;
}
