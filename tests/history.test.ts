import { describe, expect, it } from 'vitest';
import { condenseHistory } from '../src/core/history';

const turns = (n: number, answer = '回答'.repeat(200)) =>
  Array.from({ length: n }, (_, i) => ({ question: `第 ${i + 1} 个问题`, answer }));

describe('发给模型的历史：不丢问题，早期浓缩', () => {
  it('短对话原样带上', () => {
    expect(condenseHistory(turns(3))).toEqual(turns(3));
  });

  it('50 轮：每一轮的问题都还在，最近 8 轮完整，早期回答被截短', () => {
    const out = condenseHistory(turns(50));
    expect(out).toHaveLength(50);
    expect(out.map((t) => t.question)).toEqual(turns(50).map((t) => t.question));
    expect(out.slice(-8).every((t) => t.answer.length === 400)).toBe(true);
    expect(out[0]!.answer.length).toBeLessThanOrEqual(161);
  });

  it('总量超预算时继续缩早期回答，但第一个问题仍在，最近几轮不动', () => {
    const out = condenseHistory(turns(300), { recent: 4, earlierAnswerChars: 160, budgetChars: 6_000 });
    expect(out[0]!.question).toBe('第 1 个问题');
    expect(out.slice(-4).every((t) => t.answer.length === 400)).toBe(true);
    expect(out.slice(0, -4).every((t) => t.answer.length < 160)).toBe(true);
  });
});
