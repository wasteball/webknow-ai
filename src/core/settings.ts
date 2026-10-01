import { DIRECT_READ_VERIFIED } from './search/source-reader';
import { LIMITS, SUMMARY_LENGTH_CHARS, type SummaryLength } from './limits';
import { MODEL_PROVIDERS, findProvider, type ProviderId } from './model-providers';
import { resolveThinking, type ThinkingLevel, type ThinkingStore } from './model-thinking';

/**
 * 用户设置（产品化改造 F2）：纯逻辑部分——类型、默认值、校验与归一化。
 * 持久化在 background/store.ts，界面经由 PanelState.settings 读到生效值。
 */

export type PromptTarget = 'guide' | 'answer' | 'learn';

/** 各板块提示词覆盖；某项缺省时使用内置默认策略。harness 与输出契约不受覆盖影响（FR-029）。 */
export type PromptOverrides = Partial<Record<PromptTarget, string>>;

export type FontSize = 'normal' | 'large';

/** 回答里的图表：auto=模型按内容判断该不该画；off=不要图（程序侧也不注入引导）。 */
export type DiagramMode = 'auto' | 'off';

export type SettingsPatch = {
  /** 切换模型供应商；切换只影响之后的请求。 */
  provider?: ProviderId;
  model?: string;
  prompts?: PromptOverrides;
  /** 出题方式（F5）：mixed=模型按内容选择；quiz=总是选择题；open=总是开放问答。 */
  learningStyle?: 'mixed' | 'quiz' | 'open';
  maxBubbles?: number;
  summaryLength?: SummaryLength;
  fontSize?: FontSize;
  diagrams?: DiagramMode;
  /** 当前这家、当前这个模型的思考档。只接受该模型列表里有的值。 */
  thinking?: ThinkingLevel;
};

export type EffectiveSettings = {
  model: string;
  prompts: PromptOverrides;
  learningStyle: 'mixed' | 'quiz' | 'open';
  maxBubbles: number;
  summaryLength: SummaryLength;
  fontSize: FontSize;
  diagrams: DiagramMode;
  /** 当前模型的思考档。null 表示这个模型没有这一项。 */
  thinking: ThinkingLevel | null;
};

export const DEFAULT_SETTINGS: EffectiveSettings = {
  model: findProvider(undefined).defaultModel,
  prompts: {},
  learningStyle: 'mixed',
  maxBubbles: LIMITS.maxBubbles,
  summaryLength: 'medium',
  fontSize: 'normal',
  diagrams: 'auto',
  thinking: 'off',
};

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** 设置项归一化：数值夹进硬上限范围内，非法条目被丢弃而不是报错中止整个保存。 */
export function normalizeSettings(patch: SettingsPatch): SettingsPatch {
  const clean: SettingsPatch = {};
  if (patch.provider !== undefined) {
    const known = MODEL_PROVIDERS.some((provider) => provider.id === patch.provider);
    if (known) clean.provider = patch.provider;
  }
  if (patch.model !== undefined) {
    const model = patch.model.trim();
    if (model && MODEL_PATTERN.test(model)) clean.model = model;
  }
  if (patch.prompts !== undefined) {
    const prompts: PromptOverrides = {};
    for (const target of ['guide', 'answer', 'learn'] as const) {
      const value = patch.prompts[target];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue; // 空字符串 = 恢复默认，不写入
      if (trimmed.length <= LIMITS.maxTeachingPromptChars && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
        prompts[target] = trimmed;
      }
    }
    clean.prompts = prompts;
  }
  if (patch.learningStyle !== undefined) {
    if (patch.learningStyle === 'mixed' || patch.learningStyle === 'quiz' || patch.learningStyle === 'open') {
      clean.learningStyle = patch.learningStyle;
    }
  }
  if (patch.maxBubbles !== undefined) {
    clean.maxBubbles = clamp(Math.round(patch.maxBubbles), 0, LIMITS.maxBubbles);
  }
  if (patch.summaryLength !== undefined) {
    if (patch.summaryLength in SUMMARY_LENGTH_CHARS) clean.summaryLength = patch.summaryLength;
  }
  if (patch.fontSize !== undefined) {
    if (patch.fontSize === 'normal' || patch.fontSize === 'large') clean.fontSize = patch.fontSize;
  }
  if (patch.diagrams !== undefined) {
    if (patch.diagrams === 'auto' || patch.diagrams === 'off') clean.diagrams = patch.diagrams;
  }
  if (patch.thinking !== undefined) {
    if (patch.thinking === 'off' || patch.thinking === 'low' || patch.thinking === 'high' || patch.thinking === 'max' || patch.thinking === 'auto') {
      clean.thinking = patch.thinking;
    }
  }
  return clean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/**
 * Config（存储形态）→ 界面与流水线使用的生效设置。
 * 模型按当前供应商取：换供应商不会把上一家的模型 ID 带过去。
 */
export function effectiveSettings(config: {
  provider?: string;
  models?: Partial<Record<ProviderId, string>>;
  prompts?: PromptOverrides;
  learningStyle?: 'mixed' | 'quiz' | 'open';
  maxBubbles?: number;
  summaryLength?: SummaryLength;
  appearance?: { fontSize?: FontSize };
  diagrams?: DiagramMode;
  thinking?: ThinkingStore;
}): EffectiveSettings {
  const provider = findProvider(config.provider);
  const model = config.models?.[provider.id]?.trim() || provider.defaultModel;
  return {
    model,
    prompts: config.prompts ?? {},
    learningStyle: config.learningStyle ?? DEFAULT_SETTINGS.learningStyle,
    maxBubbles: clamp(config.maxBubbles ?? DEFAULT_SETTINGS.maxBubbles, 0, LIMITS.maxBubbles),
    summaryLength: config.summaryLength ?? DEFAULT_SETTINGS.summaryLength,
    fontSize: config.appearance?.fontSize ?? DEFAULT_SETTINGS.fontSize,
    diagrams: config.diagrams ?? DEFAULT_SETTINGS.diagrams,
    thinking: resolveThinking(model, config.thinking?.[provider.id]?.[model]),
  };
}

/** Stable public receiver/data declaration; deliberately allowlists no credentials or key fingerprints. */
export const OUTBOUND_NOTICE_VERSION = '2026-10-01.1';
export function outboundScope(config: {
  provider?: string;
  search?: { providerId?: string; agent?: Partial<import('./search/agent-types').AgentSettings>; credentials?: Record<string, Record<string, string>> };
}): string {
  const model = findProvider(config.provider);
  const id = config.search?.providerId ?? null;
  let origin: string | null = null;
  if (id === 'searxng') {
    try {
      const url = new URL(config.search?.credentials?.searxng?.baseUrl ?? '');
      if (url.protocol === 'https:' || url.protocol === 'http:') origin = url.origin;
    } catch { /* An invalid instance has no authorized receiver. */ }
  }
  const reading = config.search?.agent?.sourceReading ?? 'provider';
  return JSON.stringify({ version: OUTBOUND_NOTICE_VERSION, model: model.receiver, modelOrigin: model.origin,
    search: id, selfHostOrigin: origin, sourceReading: reading,
    directRead: DIRECT_READ_VERIFIED,
    contentReceiver: reading === 'off' ? null : id === 'firecrawl' ? 'https://api.firecrawl.dev' : 'unavailable',
    data: { model: 'article,question,history,search-material,source-body,readable-images-when-supported',
      search: 'query,filters,own-authentication', content: 'selected-source-urls', direct: 'unavailable' } });
}
