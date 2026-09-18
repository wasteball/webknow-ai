import { chatJson, DEEPSEEK_MODEL, type Message } from '../core/deepseek';
import { appError } from '../core/errors';
import { LIMITS } from '../core/limits';
import { readApiKey, readConfig } from './store';

/**
 * 唯一允许的模型网络边界（FR-032）。
 * Key 与模型选择在这里读取并直接用于请求，不经过界面、提示词、会话数据、日志或诊断。
 */

const TEST_MESSAGES: Message[] = [
  { role: 'system', content: '你是连接测试端点。只返回 JSON。' },
  { role: 'user', content: '返回 {"ok":true}' },
];

async function resolveModel(): Promise<string> {
  const model = (await readConfig()).model?.trim();
  return model || DEEPSEEK_MODEL;
}

export async function callModel(
  messages: Message[],
  signal: AbortSignal,
  onProgress: (chars: number) => void,
): Promise<unknown> {
  const apiKey = await readApiKey();
  if (!apiKey) {
    throw appError('NO_KEY', '还没有配置 DeepSeek Key。请在设置中填写自己的 Key 后再开始。', false);
  }
  return chatJson({
    apiKey,
    model: await resolveModel(),
    messages,
    signal,
    onProgress,
    maxTokens: LIMITS.maxOutputTokens,
  });
}

/** 连接测试：固定最小请求，不发送网页正文（FR-020）。 */
export async function testConnection(key: string): Promise<void> {
  await chatJson({
    apiKey: key.trim(),
    model: await resolveModel(),
    messages: TEST_MESSAGES,
    signal: AbortSignal.timeout(20_000),
    maxTokens: 16,
  });
}

/**
 * 拉取当前 Key 可用的模型列表（GET /models）。只传回模型 ID 字符串；
 * 拉取失败时回退到内置列表，由界面说明“未能取得完整列表”。
 */
export async function listModels(): Promise<string[]> {
  const apiKey = await readApiKey();
  if (!apiKey) throw appError('NO_KEY', '还没有配置 DeepSeek Key。', false);
  const response = await fetch('https://api.deepseek.com/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw appError('SERVICE', '没能取得模型列表，请稍后再试。', true);
  }
  const payload: unknown = await response.json();
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) throw appError('BAD_OUTPUT', '模型列表格式不对。', true);
  const ids = data
    .map((item) => (typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (!ids.length) throw appError('BAD_OUTPUT', '模型列表是空的。', true);
  return ids;
}
