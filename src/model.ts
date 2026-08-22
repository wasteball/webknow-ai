import type { ModelCapability, NormalizedError } from './contracts';
import { type ModelCredentials, modelApprovalState, modelCredentials } from './model-secret';
import { MODEL_ENDPOINT } from './provider';
import { saveModelCapability } from './storage';

const DEFAULT_TIMEOUT_MS = 45_000;

type ChatMessage = { role: 'system' | 'user'; content: string };

type ChatOptions = {
  messages: ChatMessage[];
  credentials?: ModelCredentials;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
};

export class ModelRequestError extends Error {
  constructor(readonly detail: NormalizedError) {
    super(detail.message);
    this.name = 'ModelRequestError';
  }
}

function requestError(
  code: NormalizedError['code'],
  message: string,
  retryable = false,
): ModelRequestError {
  return new ModelRequestError({ code, retryable, message });
}

function responseError(status: number, providerCode?: string): ModelRequestError {
  const code = providerCode?.toLowerCase() ?? '';
  if (status === 401 || status === 403) {
    return requestError('AUTH', 'API Key 无效或当前账号没有调用权限。');
  }
  if (status === 404) {
    return requestError('MODEL_NOT_FOUND', '接口或模型不存在，请检查模型名。');
  }
  if (status === 402 || code.includes('balance') || code.includes('insufficient')) {
    return requestError('BALANCE_INSUFFICIENT', '模型账号余额不足。');
  }
  if (status === 429) {
    return requestError('RATE_LIMITED', '模型服务当前限流，请稍后重试。', true);
  }
  if (status >= 500) {
    return requestError('NETWORK', `模型服务暂时不可用（HTTP ${status}）。`, true);
  }
  return requestError('INVALID_RESPONSE', `模型服务拒绝了请求（HTTP ${status}）。`);
}

async function providerErrorSignal(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown; type?: unknown };
    };
    return [body.error?.code, body.error?.type, body.error?.message]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
  } catch {
    return undefined;
  }
}

function timedSignal(
  parent?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
    timedOut: () => timeout,
  };
}

export async function chatJson(options: ChatOptions): Promise<unknown> {
  const credentials = options.credentials ?? (await modelCredentials());
  if (!credentials) throw requestError('NOT_CONFIGURED', '请先配置模型。');
  const timed = timedSignal(options.signal);
  try {
    const response = await fetch(MODEL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: credentials.model,
        messages: options.messages,
        response_format: { type: 'json_object' },
        stream: false,
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens ?? 3000,
      }),
      signal: timed.signal,
    });
    if (!response.ok) throw responseError(response.status, await providerErrorSignal(response));
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw requestError('INVALID_RESPONSE', '模型返回的响应不是有效 JSON。', true);
    }
    const content = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
      ?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw requestError('INVALID_RESPONSE', '模型响应缺少 JSON 内容。', true);
    }
    try {
      return JSON.parse(content);
    } catch {
      throw requestError('INVALID_RESPONSE', '模型未按要求返回 JSON 对象。', true);
    }
  } catch (error) {
    if (error instanceof ModelRequestError) throw error;
    if (timed.signal.aborted) {
      if (timed.timedOut()) throw requestError('TIMEOUT', '模型请求超时。', true);
      throw requestError('CANCELLED', '已停止本次回答。');
    }
    throw requestError('NETWORK', '无法连接模型服务，请检查网络和站点权限。', true);
  } finally {
    timed.cleanup();
  }
}

export async function testModelConnection(signal?: AbortSignal): Promise<ModelCapability> {
  const credentials = await modelCredentials();
  if (!credentials) throw requestError('NOT_CONFIGURED', '请先配置模型。');
  try {
    const response = await chatJson({
      messages: [
        { role: 'system', content: 'Return one JSON object only.' },
        { role: 'user', content: 'Return exactly {"ok":true}.' },
      ],
      credentials,
      maxTokens: 20,
      signal,
    });
    const passed =
      typeof response === 'object' &&
      response !== null &&
      (response as { ok?: unknown }).ok === true;
    const capability: ModelCapability = {
      testedAt: Date.now(),
      model: credentials.model,
      directConnection: true,
      jsonMode: passed,
      status: passed ? 'passed' : 'failed',
      detail: passed ? '直连与 JSON 模式测试通过。' : '服务可连接，但 JSON 模式结果不兼容。',
    };
    await saveModelCapability(capability, credentials.configId);
    if (!passed) throw requestError('INVALID_RESPONSE', capability.detail);
    return capability;
  } catch (error) {
    if (error instanceof ModelRequestError) {
      await saveModelCapability(
        {
          testedAt: Date.now(),
          model: credentials.model,
          directConnection: false,
          jsonMode: false,
          status: 'failed',
          detail: error.detail.message,
        },
        credentials.configId,
      );
    }
    throw error;
  }
}

export async function approvedModelCredentials(): Promise<ModelCredentials> {
  const state = await modelApprovalState();
  if (!state.credentials) throw requestError('NOT_CONFIGURED', '请先配置模型。');
  if (!state.tested) {
    throw requestError('NOT_CONFIGURED', '当前模型配置尚未通过连接与 JSON 模式测试。');
  }
  if (!state.confirmed) {
    throw requestError('PERMISSION_REQUIRED', '发送正文前需要确认外部接收方。');
  }
  return state.credentials;
}

export function normalizeThrown(error: unknown): NormalizedError {
  if (error instanceof ModelRequestError) return error.detail;
  return { code: 'INTERNAL', retryable: false, message: '处理失败，未发送或展示未经校验的结果。' };
}
