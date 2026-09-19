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

  it('有网络资料时，原文依据仍然必须有本地引用', () => {
    const result = cleanAnswer(
      { answer: '回答', source: 'original', citations: [], unanswered: [], references: [] },
      blocks,
      [{ title: '外部', url: 'https://example.com/a', snippet: '摘要' }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe('unknown');
  });
});

describe('cleanLearn', () => {
  it('返回的动作与请求模式不一致时判为无效', () => {
    expect(cleanLearn({ action: 'summary', summary: 's', nextDirections: [] }, 'ask').ok).toBe(false);
  });

  it('respond 模式允许模型改走讲解（读者说“不知道”时不许重复逼问）', () => {
    const result = cleanLearn(
      { action: 'explain', explanation: '先看正文这一段…', nextQuestion: null },
      'respond',
    );
    expect(result.ok).toBe(true);
    // 但 ask/hint/close 不接受讲解，避免模式串线。
    expect(cleanLearn({ action: 'explain', explanation: 'x', nextQuestion: null }, 'ask').ok).toBe(false);
    expect(cleanLearn({ action: 'explain', explanation: 'x', nextQuestion: null }, 'close').ok).toBe(false);
  });

  it('接受五类回答判断', () => {
    for (const verdict of ['correct', 'partial', 'misconception', 'unknown', 'objection'] as const) {
      const result = cleanLearn(
        { action: 'feedback', verdict, feedback: '反馈', nextQuestion: null },
        'respond',
        'open',
      );
      expect(result.ok).toBe(true);
    }
  });

  it('选择题轮必须用 graded，开放问题必须用 feedback（F5）', () => {
    const feedback = { action: 'feedback', verdict: 'correct', feedback: '反馈', nextQuestion: null };
    expect(cleanLearn(feedback, 'respond', 'open').ok).toBe(true);
    expect(cleanLearn(feedback, 'respond', 'quiz').ok).toBe(false);
    const graded = {
      action: 'graded',
      analysis: '整体不错',
      notes: [{ questionId: 'q1', note: '对' }],
      nextQuestion: null,
      nextQuiz: null,
    };
    expect(cleanLearn(graded, 'respond', 'quiz').ok).toBe(true);
    expect(cleanLearn(graded, 'respond', 'open').ok).toBe(false);
  });

  it('quiz 输出：答案必须是选项之一，重复题目 id 判为无效（F5）', () => {
    const valid = {
      action: 'quiz',
      questions: [
        {
          id: 'q1',
          text: '哪个说法符合正文？',
          choices: [
            { id: 'A', label: '样本只有三个团队' },
            { id: 'B', label: '结论适用于所有城市' },
          ],
          answer: ['A'],
          why: '作者明确写了不能外推。',
        },
      ],
    };
    const result = cleanLearn(valid, 'ask');
    expect(result.ok).toBe(true);
    if (result.ok && result.value.action === 'quiz') {
      expect(result.value.questions[0]?.multi).toBe(false);
      expect(result.value.answerKey[0]?.answer).toEqual(['A']);
    }
    // answer 指向不存在的选项 → 无效。
    const badAnswer = JSON.parse(JSON.stringify(valid)) as typeof valid;
    (badAnswer.questions[0] as { answer: string[] }).answer = ['Z'];
    expect(cleanLearn(badAnswer, 'ask').ok).toBe(false);
    // 题目 id 重复 → 无效。
    const duplicate = JSON.parse(JSON.stringify(valid)) as typeof valid;
    duplicate.questions.push(JSON.parse(JSON.stringify(duplicate.questions[0])));
    expect(cleanLearn(duplicate, 'ask').ok).toBe(false);
    // 多个正确答案 → multi 自动为 true。
    const multi = JSON.parse(JSON.stringify(valid)) as typeof valid;
    (multi.questions[0] as { answer: string[] }).answer = ['A', 'B'];
    const multiResult = cleanLearn(multi, 'ask');
    expect(multiResult.ok).toBe(true);
    if (multiResult.ok && multiResult.value.action === 'quiz') {
      expect(multiResult.value.questions[0]?.multi).toBe(true);
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
