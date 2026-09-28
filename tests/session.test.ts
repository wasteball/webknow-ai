import { describe, expect, it } from 'vitest';

import type { BlocksPayload } from '../src/core/blocks';
import { LIMITS } from '../src/core/limits';
import { derivePhase } from '../src/core/phase';
import {
  acceptsWriteBack,
  appendLearn,
  attachCallReasoning,
  beginRun,
  canStartLearning,
  createSession,
  markStale,
  nextQuestionAllowed,
  stateAfterFailure,
  stateAfterStop,
  type LearningState,
} from '../src/core/session';

const payload: BlocksPayload = {
  title: '测试文章',
  url: 'https://example.com/a',
  fingerprint: 'fp1',
  blocks: [
    {
      id: 'b_0',
      role: 'paragraph',
      content: '正文',
      headingPath: [],
      anchor: {
        sessionAnchorId: 'a1',
        selector: 'p',
        exact: '正文',
        prefix: '',
        suffix: '',
        headingPath: [],
        fingerprint: 'f',
      },
    },
  ],
  completeness: {
    scope: 'readability-article',
    text: { status: 'parsed', found: 1, captured: 1 },
    tables: { status: 'not-present', found: 0, captured: 0 },
    images: { status: 'not-present', found: 0, captured: 0 },
    frames: { status: 'not-present', found: 0, captured: 0 },
    excludedBlocks: 0,
    truncated: false,
    warnings: [],
  },
};

function learning(): LearningState {
  return {
    goal: '弄懂前提',
    promptVersion: 'v',
    used: 1,
    current: { kind: 'open', question: '旧问题', hintUsed: false },
    status: 'active',
    log: [{ role: 'question', text: '旧问题', at: 1 }],
  };
}

describe('这一轮的思考过程记在模型新写出的记录上', () => {
  it('记在反馈上，不记在用户回答和更早的问题上', () => {
    const before = learning();
    const after = appendLearn(appendLearn(before, { role: 'answer', text: '我的回答' }), {
      role: 'feedback',
      text: '对上了原文',
    });
    const stamped = attachCallReasoning(after, before.log.length, '先对一下原文');
    expect(stamped.log[0]?.reasoning).toBeUndefined();
    expect(stamped.log[1]?.reasoning).toBeUndefined();
    expect(stamped.log[2]?.reasoning).toBe('先对一下原文');
    expect(stamped.log[2]?.text).toBe('对上了原文');
  });

  it('空白思考过程不给记录加字段', () => {
    const before = learning();
    const after = appendLearn({ ...before, log: [] }, { role: 'question', text: '新问题' });
    const stamped = attachCallReasoning(after, 0, '  ');
    expect(stamped.log[0]).not.toHaveProperty('reasoning');
  });
});

describe('会话与请求身份', () => {
  it('同一标签页同时只允许一个在途请求', () => {
    const session = createSession(1, payload);
    const first = beginRun(session, 'guide');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = beginRun(first.session, 'answer');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('BUSY');
  });

  it('迟到结果在请求身份不匹配时必须被丢弃', () => {
    const session = createSession(1, payload);
    const begun = beginRun(session, 'guide');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(acceptsWriteBack(begun.session, begun.run.id)).toBe(true);
    expect(acceptsWriteBack(begun.session, 'r_other')).toBe(false);
  });

  it('页面变化后正文与旧结果一起作废', () => {
    const session = createSession(1, payload);
    const stale = markStale(session, 'https://example.com/b');
    expect(stale.state).toBe('STALE');
    expect(stale.blocks).toEqual([]);
    expect(stale.guide).toBeNull();
    expect(stale.url).toBe('https://example.com/b');
    expect(stale.title).toBe('');
  });

  it('还不知道新地址时不把上一页的标题留在这一页上', () => {
    const session = createSession(1, payload);
    const stale = markStale(session);
    expect(stale.state).toBe('STALE');
    expect(stale.title).toBe('');
    expect(stale.blocks).toEqual([]);
    expect(stale.chat).toEqual([]);
  });

  it('停止后按请求类型分别恢复到确定状态', () => {
    const session = createSession(1, payload);
    expect(stateAfterStop(session, 'guide')).toBe('READY_TO_START');
    expect(stateAfterStop(session, 'answer')).toBe('READY');
    expect(stateAfterStop(session, 'learn')).toBe('LEARNING');
  });

  it('失败后只有首屏需要重新开始，问答与学习保留已有记录', () => {
    const session = createSession(1, payload);
    expect(stateAfterFailure(session, 'guide')).toBe('ERROR');
    expect(stateAfterFailure(session, 'answer')).toBe('READY');
    expect(stateAfterFailure(session, 'learn')).toBe('READY');
    expect(stateAfterFailure({ ...session, learning: { goal: 'g', promptVersion: 'v', used: 1, current: null, status: 'active', log: [] } }, 'learn')).toBe('LEARNING');
  });

  it('对话不设「一轮几题」的配额，只剩一道防死循环护栏', () => {
    const base = {
      goal: 'g',
      promptVersion: 'v',
      current: null,
      status: 'active' as const,
      log: [],
    };
    // 伴随式对话由用户和内容决定聊到哪里，不由配额决定：第 5、第 20 轮都还能继续。
    expect(nextQuestionAllowed({ ...base, used: 5 })).toBe(true);
    expect(nextQuestionAllowed({ ...base, used: 20 })).toBe(true);
    expect(nextQuestionAllowed({ ...base, used: LIMITS.learnRoundsCap })).toBe(false);
  });

  it('没有首屏内容时不能进入学习', () => {
    const session = { ...createSession(1, payload), state: 'READY_TO_START' as const };
    expect(canStartLearning(session)?.code).toBe('STALE_PAGE');
  });
});

describe('derivePhase', () => {
  it('按配置 → 权限 → 会话状态排序', () => {
    expect(
      derivePhase({ hasKey: false, permission: 'granted', sessionState: 'READY', unsupportedReason: null, outboundConfirmed: true }),
    ).toBe('UNCONFIGURED');
    expect(
      derivePhase({ hasKey: true, permission: 'missing', sessionState: null, unsupportedReason: null, outboundConfirmed: true }),
    ).toBe('PERMISSION_REQUIRED');
    expect(
      derivePhase({ hasKey: true, permission: 'granted', sessionState: 'READY', unsupportedReason: null, outboundConfirmed: true }),
    ).toBe('READY');
    expect(
      derivePhase({
        hasKey: true,
        permission: 'granted',
        sessionState: 'READY',
        unsupportedReason: '不支持',
        outboundConfirmed: true,
      }),
    ).toBe('UNSUPPORTED');
  });

  it('切换供应商后即使已有结果，也先停在外发确认入口', () => {
    expect(
      derivePhase({
        hasKey: true,
        permission: 'granted',
        sessionState: 'READY',
        unsupportedReason: null,
        outboundConfirmed: false,
      }),
    ).toBe('READY_TO_START');
  });
});
