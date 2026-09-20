import { describe, expect, it } from 'vitest';

import { answerMessages } from '../src/core/prompts/answer';
import { blockIdForQuote, clipQuote, isUsableQuote } from '../src/core/quote';

const blocks = [
  { id: 'b_0', content: '试点四周后，新方案把平均处理时间从一百分钟降到八十分钟。' },
  { id: 'b_1', content: '样本只有三个经过培训的团队，结论不能直接推广。' },
];

describe('isUsableQuote', () => {
  it('太短或空白不能拿去问', () => {
    expect(isUsableQuote('啊')).toBe(false);
    expect(isUsableQuote('   ')).toBe(false);
    expect(isUsableQuote('三个团队')).toBe(true);
  });
});

describe('blockIdForQuote', () => {
  it('划词落在某一段里，就绑到那一段，方便回到原文', () => {
    expect(blockIdForQuote(blocks, '平均处理时间从一百分钟降到八十分钟')).toBe('b_0');
    expect(blockIdForQuote(blocks, '不能直接推广')).toBe('b_1');
  });

  it('对不上任何一段时不编造块 id', () => {
    expect(blockIdForQuote(blocks, '这段话正文里根本没有')).toBeNull();
  });
});

describe('answerMessages', () => {
  it('发给模型的请求里带上划词，并要求针对这段回答', () => {
    const messages = answerMessages({
      title: '试点',
      url: 'https://example.com/a',
      contextJson: '[]',
      disclosure: '已读取',
      history: [],
      question: '这段什么意思？',
      quote: { text: '平均处理时间从一百分钟降到八十分钟', blockId: 'b_0' },
    });
    expect(messages[0]?.content).toContain('划出');
    expect(messages[1]?.content).toContain('平均处理时间从一百分钟降到八十分钟');
  });
});

describe('clipQuote', () => {
  it('过长就截到上限，不把整页当划词', () => {
    const clipped = clipQuote('字'.repeat(600));
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.length).toBeLessThanOrEqual(501);
  });
});
