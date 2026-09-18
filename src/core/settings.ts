import { DEEPSEEK_MODEL } from './deepseek';
import { LIMITS, SUMMARY_LENGTH_CHARS, type SummaryLength } from './limits';
import type { SkillChoice, SkillTarget } from './skills';

/**
 * 用户设置（产品化改造 F2）：纯逻辑部分——类型、默认值、校验与归一化。
 * 持久化在 background/store.ts，界面经由 PanelState.settings 读到生效值。
 */

export type PromptTarget = 'guide' | 'answer' | 'learn';

/** 各板块提示词覆盖；某项缺省时使用内置默认策略。harness 与输出契约不受覆盖影响（FR-029）。 */
export type PromptOverrides = Partial<Record<PromptTarget, string>>;

export type FontSize = 'normal' | 'large';

export type SettingsPatch = {
  model?: string;
  prompts?: PromptOverrides;
  /** 每个板块选择的技能 ID；空字符串 = 取消技能选择（回退到默认/自定义文本）。 */
  skillChoices?: SkillChoice;
  learningBudget?: number;
  /** 出题方式（F5）：mixed=模型按内容选择；quiz=总是选择题；open=总是开放问答。 */
  learningStyle?: 'mixed' | 'quiz' | 'open';
  maxBubbles?: number;
  summaryLength?: SummaryLength;
  fontSize?: FontSize;
};

export type EffectiveSettings = {
  model: string;
  prompts: PromptOverrides;
  skillChoices: SkillChoice;
  learningBudget: number;
  learningStyle: 'mixed' | 'quiz' | 'open';
  maxBubbles: number;
  summaryLength: SummaryLength;
  fontSize: FontSize;
};

export const DEFAULT_SETTINGS: EffectiveSettings = {
  model: DEEPSEEK_MODEL,
  prompts: {},
  skillChoices: {},
  learningBudget: LIMITS.learningBudget,
  learningStyle: 'mixed',
  maxBubbles: LIMITS.maxBubbles,
  summaryLength: 'medium',
  fontSize: 'normal',
};

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** 设置项归一化：数值夹进硬上限范围内，非法条目被丢弃而不是报错中止整个保存。 */
export function normalizeSettings(patch: SettingsPatch): SettingsPatch {
  const clean: SettingsPatch = {};
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
  if (patch.skillChoices !== undefined) {
    const choices: SkillChoice = {};
    for (const target of Object.keys(patch.skillChoices) as SkillTarget[]) {
      const value = patch.skillChoices[target];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim().slice(0, 100);
      if (trimmed && /^[\w.-]+$/.test(trimmed)) choices[target] = trimmed;
    }
    clean.skillChoices = choices;
  }
  if (patch.learningBudget !== undefined) {
    clean.learningBudget = clamp(Math.round(patch.learningBudget), LIMITS.learningBudgetMin, LIMITS.learningBudgetMax);
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
  return clean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/** Config（存储形态）→ 界面与流水线使用的生效设置。 */
export function effectiveSettings(config: {
  model?: string;
  prompts?: PromptOverrides;
  skillChoices?: SkillChoice;
  learningBudget?: number;
  learningStyle?: 'mixed' | 'quiz' | 'open';
  maxBubbles?: number;
  summaryLength?: SummaryLength;
  appearance?: { fontSize?: FontSize };
}): EffectiveSettings {
  return {
    model: config.model?.trim() || DEFAULT_SETTINGS.model,
    prompts: config.prompts ?? {},
    skillChoices: config.skillChoices ?? {},
    learningBudget: clamp(
      config.learningBudget ?? DEFAULT_SETTINGS.learningBudget,
      LIMITS.learningBudgetMin,
      LIMITS.learningBudgetMax,
    ),
    learningStyle: config.learningStyle ?? DEFAULT_SETTINGS.learningStyle,
    maxBubbles: clamp(config.maxBubbles ?? DEFAULT_SETTINGS.maxBubbles, 0, LIMITS.maxBubbles),
    summaryLength: config.summaryLength ?? DEFAULT_SETTINGS.summaryLength,
    fontSize: config.appearance?.fontSize ?? DEFAULT_SETTINGS.fontSize,
  };
}
