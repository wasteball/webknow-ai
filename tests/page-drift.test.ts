import { describe, expect, it } from 'vitest';

import type { BlocksPayload } from '../src/core/blocks';
import {
  classifyPageDrift,
  planWriteBack,
  sessionWithNewExtract,
  writeBackError,
} from '../src/core/page-drift';
import { beginRun, createSession, type ChatTurn } from '../src/core/session';

const payload: BlocksPayload = {
  title: '测试文章',
  url: 'https://example.com/a',
  fingerprint: 'fp1',
  blocks: [
    {
      id: 'b_0',
      role: 'paragraph',
      content: '原来的正文',
      headingPath: [],
      anchor: {
        sessionAnchorId: 'a1',
        selector: 'p',
        exact: '原来的正文',
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

const turn: ChatTurn = {
  id: 't1',
  question: '这页在说什么',
  answer: '在说原来的正文。',
  source: 'original',
  citations: [],
  unanswered: [],
  references: [],
  followUps: [],
  at: 1,
};

describe('同一页改了正文再发出去', () => {
  it('地址没变、正文指纹变了，算作这一页被改过', () => {
    expect(classifyPageDrift(payload, { url: payload.url, fingerprint: 'fp2' })).toBe('edited');
    expect(classifyPageDrift(payload, { url: payload.url, fingerprint: payload.fingerprint })).toBe('same');
    expect(classifyPageDrift(payload, { url: 'https://example.com/b', fingerprint: 'fp2' })).toBe('replaced');
    expect(classifyPageDrift(payload, null)).toBe('unreadable');
  });

  it('同一页改过稿，这次回答仍然写上；换了地址或对不上页面时不能当成成功', () => {
    expect(planWriteBack('same', { url: payload.url })).toEqual({ action: 'commit' });
    expect(planWriteBack('edited', { url: payload.url })).toEqual({ action: 'commit' });

    const replaced = planWriteBack('replaced', { url: 'https://example.com/b' });
    expect(replaced).toEqual({ action: 'replaced', url: 'https://example.com/b' });
    expect(writeBackError(replaced)?.message).toContain('已经换了');
    expect(writeBackError(replaced)?.code).toBe('STALE_PAGE');

    const unreadable = planWriteBack('unreadable', null);
    expect(unreadable).toEqual({ action: 'unreadable' });
    expect(writeBackError(unreadable)?.message).toContain('没有写上');
    expect(writeBackError({ action: 'commit' })).toBeNull();
  });

  it('按新正文重读时留下已经说过的话，也不丢掉正在进行的这次请求', () => {
    const session = createSession(1, payload);
    const begun = beginRun({ ...session, chat: [turn] }, 'answer');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    const edited: BlocksPayload = {
      ...payload,
      title: '改过的文章',
      fingerprint: 'fp2',
      blocks: [{ ...payload.blocks[0]!, content: '发布后的正文', anchor: { ...payload.blocks[0]!.anchor, exact: '发布后的正文' } }],
    };
    const next = sessionWithNewExtract(begun.session, edited);
    expect(next).not.toBe('replaced');
    if (next === 'replaced') return;
    expect(next.fingerprint).toBe('fp2');
    expect(next.title).toBe('改过的文章');
    expect(next.blocks[0]?.content).toBe('发布后的正文');
    expect(next.chat).toEqual([turn]);
    expect(next.run?.id).toBe(begun.run.id);
    expect(next.state).toBe(begun.session.state);

    expect(sessionWithNewExtract(begun.session, { ...payload, url: 'https://example.com/b' })).toBe('replaced');
  });
});
