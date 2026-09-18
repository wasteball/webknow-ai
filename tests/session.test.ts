import { describe, expect, it } from 'vitest';

import type { BlocksPayload } from '../src/core/blocks';
import { derivePhase } from '../src/core/phase';
import {
  acceptsWriteBack,
  beginRun,
  canStartLearning,
  createSession,
  markStale,
  nextQuestionAllowed,
  stateAfterFailure,
  stateAfterStop,
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

  it('学习预算用尽后不再允许提问', () => {
    const base = {
      goal: 'g',
      promptVersion: 'v',
      current: null,
      status: 'active' as const,
      log: [],
    };
    expect(nextQuestionAllowed({ ...base, used: 4 })).toBe(true);
    expect(nextQuestionAllowed({ ...base, used: 5 })).toBe(false);
  });

  it('没有首屏内容时不能进入学习', () => {
    const session = { ...createSession(1, payload), state: 'READY_TO_START' as const };
    expect(canStartLearning(session)?.code).toBe('STALE_PAGE');
  });
});

describe('derivePhase', () => {
  it('按配置 → 权限 → 会话状态排序', () => {
    expect(
      derivePhase({ hasKey: false, permission: 'granted', sessionState: 'READY', unsupportedReason: null }),
    ).toBe('UNCONFIGURED');
    expect(
      derivePhase({ hasKey: true, permission: 'missing', sessionState: null, unsupportedReason: null }),
    ).toBe('PERMISSION_REQUIRED');
    expect(
      derivePhase({ hasKey: true, permission: 'granted', sessionState: 'READY', unsupportedReason: null }),
    ).toBe('READY');
    expect(
      derivePhase({
        hasKey: true,
        permission: 'granted',
        sessionState: 'READY',
        unsupportedReason: '不支持',
      }),
    ).toBe('UNSUPPORTED');
  });
});
