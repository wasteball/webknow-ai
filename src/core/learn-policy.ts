import { LEARN_DEFAULT_POLICY, LEARN_VERSION } from './prompts/learn';
import type { LearningState } from './session';

export type LearningStyle = 'mixed' | 'quiz' | 'open';

export const DEFAULT_LEARN_GOAL = '理解这篇文章的核心内容';

/** 点过的方向记下来：卡片已经当对话发出去了，再开一轮不能把它变回来。 */
export function rememberLearnGoal(previous: LearningState | null, goal: string): string[] {
  const prior = previous?.usedGoals ?? [];
  const extra = previous?.goal && !prior.includes(previous.goal) ? [previous.goal] : [];
  const next = goal.trim();
  return [...new Set([...prior, ...extra, next].filter(Boolean))];
}

export function usedLearnGoals(learning: LearningState | null): Set<string> {
  if (!learning) return new Set();
  return new Set(rememberLearnGoal(learning, ''));
}

function hashPolicy(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 33) + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** 启动学习时冻结策略正文、出题方式和版本号（FR-028）。 */
export function freezeLearnPolicy(input: {
  resolvedPolicy: string | undefined;
  style: LearningStyle;
}): Pick<LearningState, 'promptVersion' | 'policy' | 'style'> {
  const policy = input.resolvedPolicy?.trim() || LEARN_DEFAULT_POLICY;
  return {
    policy,
    style: input.style,
    promptVersion: `${LEARN_VERSION}:${hashPolicy(`${policy}\n${input.style}`)}`,
  };
}

/**
 * 进行中的会话用启动时的快照。
 * 旧会话没有 policy 字段时，才回退到调用方读到的当前配置。
 */
export function frozenLearnCall(
  learning: LearningState,
  fallback: { policy?: string; style: LearningStyle },
): { override: string | undefined; style: LearningStyle } {
  if (learning.policy) {
    return { override: learning.policy, style: learning.style ?? fallback.style };
  }
  return { override: fallback.policy, style: learning.style ?? fallback.style };
}

/** 「我不知道」：开放题先提示，提示过了再讲解；选择题没有这条路。 */
export function unknownAssistMode(learning: LearningState): 'hint' | 'explain' | null {
  if (learning.status !== 'active' || !learning.current) return null;
  if (learning.current.kind === 'quiz') return null;
  return learning.current.hintUsed ? 'explain' : 'hint';
}
