import { appError, fromHttpStatus, fromNetworkFailure } from './errors';
import { LIMITS } from './limits';
import type { ModelProvider } from './model-providers';

/**
 * 模型调用的共用传输层（DeepSeek 与智谱都是 OpenAI 兼容的 chat/completions + SSE）。
 * 本模块只负责“把一次请求变成一段文本”，不接触会话状态；它由 background 调用，
 * 是唯一读取 Key 的地方（FR-032）。
 *
 * 与供应商有关的差异（地址、请求体默认值、默认模型、外发接收方）全部在
 * `core/model-providers.ts`；这里只按传入的 provider 组装请求。
 */

export type Message = { role: 'system' | 'user'; content: string };

export type ChatOptions = {
  apiKey: string;
  /** 用哪家供应商：决定地址、鉴权头、请求体默认值与默认模型。 */
  provider: ModelProvider;
  /** 模型 ID；缺省用该供应商的默认模型。设置里选择的模型在这里生效。 */
  model?: string;
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
  const { apiKey, provider, messages, signal, onProgress } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(LIMITS.requestTimeoutMs);
  const combined = AbortSignal.any([signal, timeout]);

  let response: Response;
  try {
    response = await doFetch(provider.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model?.trim() || provider.defaultModel,
        messages,
        stream: true,
        max_tokens: options.maxTokens ?? LIMITS.maxOutputTokens,
        ...provider.bodyDefaults,
      }),
      signal: combined,
    });
  } catch {
    if (signal.aborted) throw appError('ABORTED', '已经按你的要求停下来了。');
    if (timeout.aborted) {
      throw appError('TIMEOUT', '等太久了，DeepSeek 一直没回话。这次没有结果，可以再试一次。', true);
    }
    throw fromNetworkFailure(globalThis.navigator?.onLine === false ? 'offline' : 'unknown');
  }

  if (!response.ok) {
    throw fromHttpStatus(response.status);
  }
  if (!response.body) {
    throw appError('SERVICE', 'DeepSeek 没有回任何内容。这次没有结果，可以再试一次。', true);
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
    if (signal.aborted) throw appError('ABORTED', '已经按你的要求停下来了。');
    if (timeout.aborted) {
      throw appError('TIMEOUT', 'DeepSeek 回到一半断了。这次没有结果，可以再试一次。', true);
    }
    throw appError('SERVICE', '读 DeepSeek 的回复时出错了。可以再试一次。', true);
  } finally {
    reader.releaseLock();
  }

  onProgress?.(text.length);
  if (sse.finishReason() === 'length') {
    // 截断必须如实说明，不能把半截 JSON 当成完整结果（FR-018）。
    throw appError(
      'BAD_OUTPUT',
      '这一页的内容太多，回答写到一半就到上限了。我们没有把半截内容当成完整结果；换一篇短一点的文章再试。',
      true,
    );
  }
  const parsed = parseJsonLoose(text);
  if (parsed === undefined) {
    throw appError('BAD_OUTPUT', '这次生成的内容没法用，没有采用。可以再试一次。', true);
  }
  return parsed;
}
