import { appError, fromHttpStatus, fromNetworkFailure } from './errors';
import { LIMITS } from './limits';
import type { ModelProvider } from './model-providers';
import { thinkingRequest } from './model-thinking';
import { readerDraft } from './stream-draft';
import { visionBody, visionTextFrom } from './vision';

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
  /** 这个模型记下的思考档。缺省按模型表的默认档；没有档位表的名字维持该供应商今天的请求体。 */
  thinking?: string;
  messages: Message[];
  signal: AbortSignal;
  /**
   * 已生成字符数，加上此刻能给读者看的草稿，以及单独累计的思考过程。
   * 字符数只用于计量；草稿是抽出来的正文，思考过程不混进正文，两者都不进日志（FR-037）。
   */
  onProgress?: (chars: number, draft: string, reasoning: string) => void;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

/** 从 SSE 文本流中取出增量内容；跨 chunk 的半行由内部缓冲处理。 */
export function createSseReader() {
  let buffer = '';
  const state = { finishReason: '', reasoning: '' };
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
    /** 模型写出的思考过程。和正文分片分开，空字符串表示这一轮没有。 */
    reasoning(): string {
      return state.reasoning;
    },
  };
}

function readDeltas(lines: string[], state: { finishReason: string; reasoning: string }): string[] {
  const deltas: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed: unknown = JSON.parse(data);
      const thought = pickString(parsed, ['choices', 0, 'delta', 'reasoning_content']);
      if (thought) state.reasoning += thought;
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

/**
 * 从失败响应里取出**只用于分类**的错误码与一句话。
 *
 * 为什么要读正文：只看 HTTP 状态会分错类——429 在 DeepSeek 是"限流"，
 * 在智谱是"余额不足"（code 1113），两者给用户的下一步完全不同。
 *
 * 边界：读到的内容只喂给分类函数，**绝不进界面、日志或会话**；
 * 截断到 2KB，解析失败就退回只按状态码分类。成功路径不读正文。
 */
async function failureHint(
  response: Response,
  providerName: string,
): Promise<{ providerName: string; code?: string; detail?: string }> {
  const hint: { providerName: string; code?: string; detail?: string } = { providerName };
  try {
    const text = (await response.text()).slice(0, 2000);
    const parsed: unknown = JSON.parse(text);
    const body = parsed as { error?: { code?: unknown; message?: unknown }; code?: unknown; message?: unknown };
    const raw = body.error?.code ?? body.code;
    const message = body.error?.message ?? body.message;
    if (raw !== undefined) hint.code = String(raw);
    if (typeof message === 'string') hint.detail = message.slice(0, 300);
  } catch {
    // 读不出来或不是 JSON：保持只有状态码，分类照旧
  }
  return hint;
}

/** 模型偶尔会包上代码块或前后缀；这里只做容忍解析，不做猜测性修补。 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(trimmed);
    const candidate = (fenced?.[1] ?? trimmed).trim();
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
  if (signal.aborted) throw appError('ABORTED', '已经按你的要求停下来了。');
  const model = options.model?.trim() || provider.defaultModel;
  const request = thinkingRequest({
    providerId: provider.id,
    modelId: model,
    stored: options.thinking,
    maxTokens: options.maxTokens,
  });
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    max_tokens: request.maxTokens,
    ...provider.bodyDefaults,
  };
  if (request.thinking) body.thinking = request.thinking;
  else delete body.thinking;
  if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;
  else delete body.reasoning_effort;
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
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch {
    if (signal.aborted) throw appError('ABORTED', '已经按你的要求停下来了。');
    if (timeout.aborted) {
      throw appError('TIMEOUT', `等太久了，${provider.name} 一直没回话。这次没有结果，可以再试一次。`, true);
    }
    throw fromNetworkFailure(globalThis.navigator?.onLine === false ? 'offline' : 'unknown', provider.name);
  }

  if (!response.ok) {
    throw fromHttpStatus(response.status, await failureHint(response, provider.name));
  }
  if (!response.body) {
    throw appError('SERVICE', `${provider.name} 没有回任何内容。这次没有结果，可以再试一次。`, true);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = createSseReader();
  let text = '';
  let lastReported = 0;
  let lastDraft = '';
  let lastReasoning = '';
  const report = (force: boolean) => {
    if (!onProgress) return;
    const draft = readerDraft(text);
    const reasoning = sse.reasoning();
    if (!force && draft === lastDraft && reasoning === lastReasoning && text.length - lastReported < 200) return;
    lastReported = text.length;
    lastDraft = draft;
    lastReasoning = reasoning;
    onProgress(text.length, draft, reasoning);
  };
  const absorb = (deltas: string[]) => {
    if (deltas.length === 0) {
      report(false);
      return;
    }
    for (const delta of deltas) {
      text += delta;
      report(false);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw appError('ABORTED', '已经按你的要求停下来了。');
      if (timeout.aborted) throw appError('TIMEOUT', '模型回复超过等待上限。', true);
      if (done) break;
      absorb(sse.push(decoder.decode(value, { stream: true })));
    }
    absorb(sse.flush());
  } catch {
    if (signal.aborted) throw appError('ABORTED', '已经按你的要求停下来了。');
    if (timeout.aborted) {
      throw appError('TIMEOUT', `${provider.name} 回到一半断了。这次没有结果，可以再试一次。`, true);
    }
    throw appError('SERVICE', `读 ${provider.name} 的回复时出错了。可以再试一次。`, true);
  } finally {
    reader.releaseLock();
  }

  report(true);
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

/**
 * 读一张图。不走 JSON 模式，并强制关掉思考，否则输出额度会被思考过程耗光。
 * 图片地址只进请求体，不进日志。
 */
export async function chatVision(options: {
  apiKey: string;
  endpoint: string;
  providerName: string;
  imageUrl: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const timeout = AbortSignal.timeout(LIMITS.visionTimeoutMs);
  const combined = AbortSignal.any([options.signal, timeout]);
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(options.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(visionBody(options.imageUrl)),
      signal: combined,
    });
  } catch {
    if (options.signal.aborted) throw appError('ABORTED', '已经按你的要求停下来了。');
    if (timeout.aborted) {
      throw appError('TIMEOUT', `这张图等太久了，${options.providerName} 没有读出来。`, true);
    }
    throw fromNetworkFailure(globalThis.navigator?.onLine === false ? 'offline' : 'unknown', options.providerName);
  }
  if (!response.ok) {
    throw fromHttpStatus(response.status, await failureHint(response, options.providerName));
  }
  return visionTextFrom(await response.json());
}
