import { describe, expect, it } from 'vitest';

import type { EvidenceBlock } from '../src/core/blocks';
import { cleanAnswer, cleanGuide, cleanLearn, validateTeachingPrompt } from '../src/core/validate';

function block(id: string): EvidenceBlock {
  return {
    id,
    role: 'paragraph',
    content: `内容 ${id}`,
    headingPath: [],
    anchor: {
      sessionAnchorId: `a-${id}`,
      selector: 'p',
      exact: `内容 ${id}`,
      prefix: '',
      suffix: '',
      headingPath: [],
      fingerprint: 'f',
    },
  };
}

const blocks = [block('b_0'), block('b_1')];

describe('cleanGuide', () => {
  it('截到气泡上限并按文本去重', () => {
    const result = cleanGuide({
      summary: '摘要',
      bubbles: [
        { question: '作者的理由是什么？', kind: 'reason' },
        { question: '作者的理由是什么', kind: 'reason' },
        { question: '有哪些前提？', kind: 'premise' },
        { question: '举一个例子？', kind: 'example' },
        { question: '适用边界在哪？', kind: 'boundary' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bubbles).toHaveLength(3);
    expect(result.value.bubbles.map((bubble) => bubble.question)).toEqual([
      '作者的理由是什么？',
      '有哪些前提？',
      '举一个例子？',
    ]);
  });

  it('结构不符时判为无效输出', () => {
    expect(cleanGuide({ summary: '', bubbles: [] }).ok).toBe(false);
  });
});

describe('cleanAnswer', () => {
  it('丢弃不存在的块 id', () => {
    const result = cleanAnswer(
      { answer: '回答', source: 'original', citations: ['b_0', '不存在'], unanswered: [] },
      blocks,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations).toEqual([{ blockId: 'b_0' }]);
    expect(result.value.source).toBe('original');
  });

  it('声称原文依据却拿不出有效引用时降级为无法确认', () => {
    const result = cleanAnswer({ answer: '回答', source: 'original', citations: ['x'], unanswered: [] }, blocks);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe('unknown');
    expect(result.value.unanswered.join()).toContain('未能在当前正文中找到可直接核对的依据');
  });
});

describe('cleanLearn', () => {
  it('返回的动作与请求模式不一致时判为无效', () => {
    expect(cleanLearn({ action: 'summary', summary: 's', nextDirections: [] }, 'ask').ok).toBe(false);
  });

  it('接受五类回答判断', () => {
    for (const verdict of ['correct', 'partial', 'misconception', 'unknown', 'objection'] as const) {
      const result = cleanLearn(
        { action: 'feedback', verdict, feedback: '反馈', nextQuestion: null },
        'respond',
      );
      expect(result.ok).toBe(true);
    }
  });
});

describe('validateTeachingPrompt', () => {
  it('拒绝空内容与控制字符，且不影响上一次有效值', () => {
    expect(validateTeachingPrompt('   ').ok).toBe(false);
    expect(validateTeachingPrompt('正常\u0000内容').ok).toBe(false);
    expect(validateTeachingPrompt('正常内容').ok).toBe(true);
  });
});
