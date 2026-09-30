import { LIMITS } from './limits';
import { findProvider, type ProviderId } from './model-providers';

/** 设置页上的一档。auto 是「默认」：不额外写思考字段。 */
export type ThinkingLevel = 'off' | 'low' | 'high' | 'max' | 'auto';

export type ThinkingChoice = { value: ThinkingLevel; label: string };

export type ThinkingStore = Partial<Record<ProviderId, Partial<Record<string, ThinkingLevel>>>>;

const LABELS: Record<ThinkingLevel, string> = {
  off: '关',
  low: '低',
  high: '高',
  max: '极致',
  auto: '默认',
};

/** 只给文档和本机对照都对得上的模型暴露档位。其余模型维持今天的请求体。 */
const KNOWN: Record<string, { levels: readonly ThinkingLevel[]; defaultLevel: ThinkingLevel }> = {
  'deepseek-flash': { levels: ['off', 'low', 'high', 'max'], defaultLevel: 'off' },
  'deepseek-v4-pro': { levels: ['off', 'low', 'high', 'max'], defaultLevel: 'off' },
  // 2026-09-30 真实请求：默认思考会占满 16-token 连接测试，关闭后正常返回 JSON。
  'glm-4.6': { levels: ['off', 'auto'], defaultLevel: 'off' },
  'glm-5.2': { levels: ['auto', 'off', 'high', 'max'], defaultLevel: 'auto' },
};

const EFFORT: Partial<Record<ThinkingLevel, 'low' | 'high' | 'max'>> = {
  low: 'low',
  high: 'high',
  max: 'max',
};

export function thinkingChoices(modelId: string): ThinkingChoice[] | null {
  const spec = KNOWN[modelId];
  if (!spec) return null;
  return spec.levels.map((value) => ({ value, label: LABELS[value] }));
}

/** 这个模型当前生效的档。没有档位表时返回 null，调用方维持该供应商今天的请求体。 */
export function resolveThinking(modelId: string, stored: string | undefined): ThinkingLevel | null {
  const spec = KNOWN[modelId];
  if (!spec) return null;
  if (stored && spec.levels.includes(stored as ThinkingLevel)) return stored as ThinkingLevel;
  return spec.defaultLevel;
}

export type ThinkingRequest = {
  thinking?: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'low' | 'high' | 'max';
  maxTokens: number;
};

/**
 * 这一次请求要多写的思考字段，以及输出上限。
 * 连接测试传入自己的 maxTokens 时不抬高。未知模型名不看存下来的档。
 */
export function thinkingRequest(input: {
  providerId: ProviderId;
  modelId: string;
  stored?: string;
  maxTokens?: number;
}): ThinkingRequest {
  const level = resolveThinking(input.modelId, input.stored);
  const effort = level ? EFFORT[level] : undefined;
  const maxTokens =
    input.maxTokens ?? (effort ? LIMITS.maxOutputTokensThinking : LIMITS.maxOutputTokens);

  if (level === null) {
    if (input.providerId === 'deepseek') return { thinking: { type: 'disabled' }, maxTokens };
    return { maxTokens };
  }
  if (level === 'off') return { thinking: { type: 'disabled' }, maxTokens };
  if (!effort) return { maxTokens };
  return { thinking: { type: 'enabled' }, reasoningEffort: effort, maxTokens };
}

/** 把一次设置保存写进「每家、每个模型各记一档」。不认识的档或没有档位的模型保持原样。 */
export function rememberThinking(
  current: {
    provider?: string;
    models?: Partial<Record<ProviderId, string>>;
    thinking?: ThinkingStore;
  },
  patch: { provider?: ProviderId; model?: string; thinking?: ThinkingLevel },
): ThinkingStore | undefined {
  if (patch.thinking === undefined) return current.thinking;
  const providerId = findProvider(patch.provider ?? current.provider).id;
  const model = (patch.model ?? current.models?.[providerId] ?? findProvider(providerId).defaultModel).trim();
  const allowed = thinkingChoices(model)?.some((choice) => choice.value === patch.thinking);
  if (!allowed) return current.thinking;
  return {
    ...current.thinking,
    [providerId]: { ...current.thinking?.[providerId], [model]: patch.thinking },
  };
}
