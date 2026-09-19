import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEARN_GOAL,
  freezeLearnPolicy,
  frozenLearnCall,
  rememberLearnGoal,
  unknownAssistMode,
  usedLearnGoals,
} from '../src/core/learn-policy';
import { LEARN_DEFAULT_POLICY } from '../src/core/prompts/learn';
import type { LearningState } from '../src/core/session';

function session(partial: Partial<LearningState>): LearningState {
  return {
    goal: 'g',
    promptVersion: 'v',
    used: 1,
    current: { kind: 'open', question: '为什么？', hintUsed: false },
    status: 'active',
    log: [],
    ...partial,
  };
}

describe('freezeLearnPolicy', () => {
  it('启动时把策略正文和出题方式写进快照，之后改配置也不变', () => {
    const first = freezeLearnPolicy({ resolvedPolicy: '用追问', style: 'open' });
    expect(first.policy).toBe('用追问');
    expect(first.style).toBe('open');
    expect(first.promptVersion.length).toBeGreaterThan(4);

    const later = freezeLearnPolicy({ resolvedPolicy: '改成别的', style: 'quiz' });
    expect(later.promptVersion).not.toBe(first.promptVersion);
    expect(first.policy).toBe('用追问');
  });

  it('没覆盖时记下当时的默认策略正文，不留空让后续重读配置', () => {
    const frozen = freezeLearnPolicy({ resolvedPolicy: undefined, style: 'mixed' });
    expect(frozen.policy).toBe(LEARN_DEFAULT_POLICY);
    expect(frozen.style).toBe('mixed');
  });
});

describe('frozenLearnCall', () => {
  it('有快照就用快照，忽略后来的配置', () => {
    const learning = session({
      policy: '启动时的写法',
      style: 'open',
    });
    expect(frozenLearnCall(learning, { policy: '后来改的', style: 'quiz' })).toEqual({
      override: '启动时的写法',
      style: 'open',
    });
  });

  it('旧会话没有快照时才回退到当前配置', () => {
    const learning = session({});
    expect(frozenLearnCall(learning, { policy: '现在的覆盖', style: 'quiz' })).toEqual({
      override: '现在的覆盖',
      style: 'quiz',
    });
  });
});

describe('rememberLearnGoal', () => {
  it('点过的方向留下来，再开一轮不会把已经发出去的卡片变回来', () => {
    expect(rememberLearnGoal(null, DEFAULT_LEARN_GOAL)).toEqual([DEFAULT_LEARN_GOAL]);
    const first = session({ goal: DEFAULT_LEARN_GOAL, usedGoals: [DEFAULT_LEARN_GOAL], status: 'closed' });
    expect(rememberLearnGoal(first, '为什么三个团队不能代表其他城市？')).toEqual([
      DEFAULT_LEARN_GOAL,
      '为什么三个团队不能代表其他城市？',
    ]);
  });
});

describe('usedLearnGoals', () => {
  it('旧会话没有 usedGoals 时，当前 goal 也算已经发出去了', () => {
    expect(usedLearnGoals(session({ goal: DEFAULT_LEARN_GOAL }))).toEqual(new Set([DEFAULT_LEARN_GOAL]));
    expect(usedLearnGoals(null).size).toBe(0);
  });
});

describe('unknownAssistMode', () => {
  it('开放题还没用过提示时，先给提示', () => {
    expect(unknownAssistMode(session({ current: { kind: 'open', question: 'q', hintUsed: false } }))).toBe('hint');
  });

  it('已经给过提示，再点「我不知道」就直接讲解', () => {
    expect(unknownAssistMode(session({ current: { kind: 'open', question: 'q', hintUsed: true } }))).toBe('explain');
  });

  it('选择题轮没有「我不知道」这条路', () => {
    expect(
      unknownAssistMode(
        session({
          current: { kind: 'quiz', questions: [], answerKey: [] },
        }),
      ),
    ).toBeNull();
  });
});
