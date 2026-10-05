import { describe, expect, it } from 'vitest';

import { hasAskedQuestion, normalizeQuestion, startsNewTopic, topicHistory } from '../src/core/topic';

describe('Ask AI topic boundaries', () => {
  it('only treats explicit topic wording as a switch', () => {
    expect(startsNewTopic('换个主题，讲讲限制')).toBe(true);
    expect(startsNewTopic('先聊聊文章的例子')).toBe(true);
    expect(startsNewTopic('为什么会这样？')).toBe(false);
    expect(startsNewTopic('详细解释一下')).toBe(false);
  });

  it('normalizes punctuation and spacing for question de-duplication', () => {
    expect(normalizeQuestion('  这 是 什么？ ')).toBe('这是什么');
    expect(hasAskedQuestion(['这是什么？'], '这 是 什么')).toBe(true);
    expect(hasAskedQuestion(['为什么？'], '怎么做')).toBe(false);
  });

  it('keeps only the active topic while preserving legacy turns when needed', () => {
    const turns = [{ topicId: 'a', text: 'a' }, { topicId: 'b', text: 'b' }, { text: 'old' }];
    expect(topicHistory(turns, 'b')).toEqual([{ topicId: 'b', text: 'b' }]);
    expect(topicHistory(turns, 'legacy', true)).toEqual([{ text: 'old' }]);
  });
});

it('keeps the helper contract small', () => {
  expect(startsNewTopic('换个话题')).toBe(true);
});
