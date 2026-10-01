import { browser } from 'wxt/browser';
import type { RunIdentity } from '../core/search/agent-types';
import { effectiveAgentSettings } from '../core/search/agent-policy';
import { resolveThinking } from '../core/model-thinking';
import { getSession } from './store';
import { readPageIdentity } from './page';
import { appError } from '../core/errors';
import { chatJson, chatVision, type Message } from '../core/model-call';
import { findProvider, type ModelProvider } from '../core/model-providers';
import { hasOutboundConfirmation, readApiKey, readConfig, type Config } from './store';

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

/** 网络出口必须重新检查当前接收方，防止旧侧栏或并发切换绕过确认。 */
export function assertOutboundConfirmation(config: Config): void {
  if (!hasOutboundConfirmation(config)) {
    throw appError(
      'OUTBOUND_CONFIRMATION_REQUIRED',
      '模型接收方还没有经过你确认。请回到侧栏阅读外发说明并点确认后继续。',
      false,
    );
  }
}

export async function callModel(
  messages: Message[],
  signal: AbortSignal,
  onProgress: (chars: number, draft: string, reasoning: string) => void,
): Promise<unknown> {
  const config = await readConfig();
  assertOutboundConfirmation(config);
  const provider = findProvider(config.provider);
  const apiKey = await readApiKey(provider.id);
  if (!apiKey) {
    throw appError('NO_KEY', `还没有配置 ${provider.name} 的钥匙。请在设置中填写后再开始。`, false);
  }
  const model = config.models?.[provider.id];
  const modelId = model?.trim() || provider.defaultModel;
  return chatJson({
    apiKey,
    provider,
    model,
    thinking: config.thinking?.[provider.id]?.[modelId],
    messages,
    signal,
    onProgress,
  });
}

/** 读一张图。只有 DeepSeek 有这个视觉模型；别的供应商返回空字符串。 */
export async function readImage(imageUrl: string, signal: AbortSignal): Promise<string> {
  const config = await readConfig();
  assertOutboundConfirmation(config);
  const provider = findProvider(config.provider);
  if (provider.id !== 'deepseek') return '';
  const apiKey = await readApiKey(provider.id);
  if (!apiKey) return '';
  return chatVision({
    apiKey,
    endpoint: provider.endpoint,
    providerName: provider.name,
    imageUrl,
    signal,
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

/** Frozen research receiver; credentials are read only at this network boundary. */
export async function callResearchModel(input: {
  identity: RunIdentity; messages: Message[]; signal: AbortSignal; thinking?: string; searchProviderId?: string;
}): Promise<unknown> {
  const assertConfig = (config: Config) => {
    const provider = findProvider(config.provider);
    const modelId = config.models?.[provider.id]?.trim() || provider.defaultModel;
    const thinking = resolveThinking(modelId, config.thinking?.[provider.id]?.[modelId]) ?? undefined;
    if (provider.id !== input.identity.modelProvider || modelId !== input.identity.modelId || thinking !== input.thinking ||
        input.searchProviderId !== undefined && config.search?.providerId !== input.searchProviderId) {
      throw appError('STALE_PAGE', '页面或模型已经变化，请重新提问。');
    }
    assertOutboundConfirmation(config);
    if (!effectiveAgentSettings(config).enabled) throw appError('ABORTED', '联网已关闭。');
    return provider;
  };
  const assertPage = async () => {
    const live = await readPageIdentity(input.identity.tabId);
    const fresh = await getSession(input.identity.tabId);
    if (fresh?.id !== input.identity.sessionId || fresh.run?.id !== input.identity.runId ||
        fresh.url !== input.identity.url || fresh.fingerprint !== input.identity.fingerprint ||
        live?.url !== input.identity.url || live.fingerprint !== input.identity.fingerprint) {
      throw appError('STALE_PAGE', '页面或模型已经变化，请重新提问。');
    }
    if (input.signal.aborted) throw appError('ABORTED', '已停止本次研究。');
  };
  const provider = assertConfig(await readConfig());
  await assertPage();
  if (!await browser.permissions.contains({ origins: [provider.origin] })) throw appError('PERMISSION_MISSING', '模型服务的访问权限已失效。');
  const apiKey = await readApiKey(provider.id);
  if (!apiKey) throw appError('NO_KEY', `还没有配置 ${provider.name} 的钥匙。`, false);
  // Config/page may change while permission or key storage awaits settle.
  await assertPage();
  assertConfig(await readConfig());
  if (input.signal.aborted) throw appError('ABORTED', '已停止本次研究。');
  return chatJson({ apiKey, provider, model: input.identity.modelId, thinking: input.thinking,
    messages: input.messages, signal: input.signal });
}
