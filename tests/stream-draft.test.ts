import { describe, expect, it } from 'vitest';

import { presentReasoning, readerDraft, visibleDraft } from '../src/core/stream-draft';

describe('readerDraft', () => {
  it('字段还没开始时是空的', () => {
    expect(readerDraft('')).toBe('');
    expect(readerDraft('```json\n{"ans')).toBe('');
    expect(readerDraft('{"answer":')).toBe('');
  });

  it('随着回答字符串变长，解出已写完的正文', () => {
    expect(readerDraft('{"answer":"原')).toBe('原');
    expect(readerDraft('{"answer":"原文依据\\n第二句"')).toBe('原文依据\n第二句');
    expect(readerDraft('{"answer":"他说\\"到此\\""}')).toBe('他说"到此"');
  });

  it('末尾没写完的转义先不显示', () => {
    expect(readerDraft('{"answer":"你好\\')).toBe('你好');
    expect(readerDraft('{"answer":"你好\\u4e')).toBe('你好');
    expect(readerDraft('{"answer":"你好\\u4e2d"}')).toBe('你好中');
  });

  it('引用、后续问题和 JSON 壳不进草稿', () => {
    const partial =
      '{"answer":"正文在这里","source":"original","citations":["b_5"],"unanswered":["还没问到"],"followUps":[{"question":"再问一句"}]}';
    const draft = readerDraft(partial);
    expect(draft).toBe('正文在这里');
    expect(draft).not.toContain('b_5');
    expect(draft).not.toContain('再问一句');
    expect(draft).not.toContain('{');
  });

  it('首屏只露摘要，气泡问题等校验完再出现', () => {
    const partial = '{"summary":"这篇文章在讲边界","bubbles":[{"question":"边界在哪","kind":"boundary"}]}';
    expect(readerDraft(partial)).toBe('这篇文章在讲边界');
  });

  it('学习反馈不提前露出下一问', () => {
    const partial = '{"action":"feedback","verdict":"partial","feedback":"方向对","nextQuestion":"那边界呢"}';
    expect(readerDraft(partial)).toBe('方向对');
  });

  it('选择题只露题干和选项，不露答案和理由', () => {
    const partial =
      '{"action":"quiz","questions":[{"id":"q1","text":"题干","choices":[{"id":"A","label":"对的"},{"id":"B","label":"错的"}],"answer":["A"],"why":"因为选对"}]}';
    const draft = readerDraft(partial);
    expect(draft).toBe('题干\n\n对的\n\n错的');
    expect(draft).not.toContain('因为选对');
    expect(draft).not.toContain('A');
  });
});

describe('visibleDraft', () => {
  it('草稿里的块编号在送到界面前去掉', () => {
    expect(visibleDraft('{"answer":"作者认为这是低成本的底线试探（b_5）。"}', ['b_5'])).toBe(
      '作者认为这是低成本的底线试探。',
    );
  });
});

describe('presentReasoning', () => {
  it('思考过程去掉块编号，空白则当作没有', () => {
    expect(presentReasoning('先看（b_5）再写。', ['b_5'])).toBe('先看再写。');
    expect(presentReasoning('  \n', ['b_5'])).toBe('');
  });
});
