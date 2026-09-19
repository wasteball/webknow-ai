import { appError } from '../core/errors';
import { LIMITS } from '../core/limits';
import { chatJson, type Message } from '../core/model-call';
import { findProvider, type ModelProvider } from '../core/model-providers';
import { readApiKey, readConfig } from './store';

/**
 * 唯一允许的模型网络边界（FR-032）。
 * Key 与模型选择在这里读取并直接用于请求，不经过界面、提示词、会话数据、日志或诊断。
 * 用哪家供应商由配置决定；每家的 Key 分开存，不会把 A 家的 Key 发给 B 家。
 */

const TEST_MESSAGES: Message[] = [
  { role: 'system', content: '你是连接测试端点。只返回 JSON。' },
  { role: 'user', content: '返回 {"ok":true}' },
];

/** 当前配置选中的供应商。 */
export async function currentProvider(): Promise<ModelProvider> {
  return findProvider((await readConfig()).provider);
}

export async function callModel(
  messages: Message[],
  signal: AbortSignal,
  onProgress: (chars: number) => void,
): Promise<unknown> {
  const config = await readConfig();
  const provider = findProvider(config.provider);
  const apiKey = await readApiKey(provider.id);
  if (!apiKey) {
    throw appError('NO_KEY', `还没有配置 ${provider.name} 的钥匙。请在设置中填写后再开始。`, false);
  }
  return chatJson({
    apiKey,
    provider,
    model: config.models?.[provider.id],
    messages,
    signal,
    onProgress,
    maxTokens: LIMITS.maxOutputTokens,
  });
}

/**
 * 连接测试：用指定供应商与**还没保存的** key 发一次最小请求（保存前先验证）。
 * 不发送网页正文（FR-020）。
 */
export async function testConnection(providerId: string, key: string): Promise<void> {
  await chatJson({
    apiKey: key.trim(),
    provider: findProvider(providerId),
    messages: TEST_MESSAGES,
    signal: AbortSignal.timeout(20_000),
    maxTokens: 16,
  });
}

/**
 * 拉取该供应商可用的模型列表。只传回模型 ID 字符串。
 * 没有列表接口（智谱）时直接返回内置候选；拉取失败时由界面回退到内置列表并如实说明。
 */
export async function listModels(providerId: string, key: string): Promise<string[]> {
  const provider = findProvider(providerId);
  if (!provider.modelsEndpoint) return provider.knownModels;
  const response = await fetch(provider.modelsEndpoint, {
    headers: { Authorization: `Bearer ${key.trim()}` },
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
