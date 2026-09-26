import { describe, expect, it } from 'vitest';

import { visibleSuggestions } from '../src/sidepanel/suggest';

const openers = [
  { id: 'bub_0', question: '为什么没人再逼他喝酒？' },
  { id: 'bub_1', question: '酒桌文化的成本低在哪里？' },
];

describe('visibleSuggestions', () => {
  it('还没开口时只显示开场卡片', () => {
    expect(
      visibleSuggestions({
        chatLength: 0,
        busy: false,
        hiding: false,
        hiddenAtTurns: 0,
        openers,
        followUps: [],
        askedQuestions: [],
      }).openers,
    ).toEqual(openers);
  });

  it('点下去、回答还没回来时先把上一排藏起来', () => {
    const row = visibleSuggestions({
      chatLength: 0,
      busy: false,
      hiding: true,
      hiddenAtTurns: 0,
      openers,
      followUps: [],
      askedQuestions: [],
    });
    expect(row.openers).toEqual([]);
    expect(row.next).toEqual([]);
  });

  it('回答写回后立刻显示这一轮的联想，不继续藏着', () => {
    const followUps = [{ id: 'next_0', question: '这种测试以后还会换形式吗？' }];
    const row = visibleSuggestions({
      chatLength: 1,
      busy: false,
      hiding: true,
      hiddenAtTurns: 0,
      openers,
      followUps,
      askedQuestions: ['为什么没人再逼他喝酒？'],
    });
    expect(row.nextFrom).toBe('follow');
    expect(row.next).toEqual(followUps);
    expect(row.openers).toEqual([]);
  });

  it('模型没给联想时，留下还没问过的开场问题', () => {
    const row = visibleSuggestions({
      chatLength: 1,
      busy: false,
      hiding: false,
      hiddenAtTurns: 0,
      openers,
      followUps: [],
      askedQuestions: ['为什么没人再逼他喝酒？'],
    });
    expect(row.nextFrom).toBe('opener');
    expect(row.next.map((item) => item.question)).toEqual(['酒桌文化的成本低在哪里？']);
  });
});
