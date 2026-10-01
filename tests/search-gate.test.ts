import { describe, expect, it } from 'vitest';
import { evaluateSearchGate } from '../src/core/search/gate';
import { buildTimeContext } from '../src/core/search/time';

const input = {
  question: '今天上海实施的政策是什么？', pageTitle: '政策介绍', quote: null,
  mode: 'auto' as const, enabled: true, freshness: 'auto' as const,
  now: new Date('2026-10-01T16:30:00Z'), timeZone: 'Asia/Shanghai',
};
describe('layered search gate', () => {
  it('keeps the live-data requirement when networking is off', () => {
    const gate = evaluateSearchGate({ ...input, mode: 'force', enabled: false });
    expect(gate).toMatchObject({ level: 'required', canSearch: false, mustSearch: false });
    expect(gate.time.localDate).toBe('2026-10-02');
  });
  it('honors article permission without erasing the live requirement', () => {
    expect(evaluateSearchGate({ ...input, mode: 'article' })).toMatchObject({
      level: 'required', canSearch: false, mustSearch: false,
    });
  });
  it.each(['解释文中“最新政策”一词', '总结本文关于今天的段落', '核对文章里作者是否提到最新版本'])('keeps article tasks local: %s', (question) => {
    expect(evaluateSearchGate({ ...input, question })).toMatchObject({ level: 'not_needed', canSearch: false });
  });
  it('does not trigger on time words only in the page or quote', () => {
    expect(evaluateSearchGate({ ...input, question: '解释这段话', pageTitle: '最新政策', quote: '今天生效' }).level).toBe('not_needed');
  });
  it.each(['查证作者说法', '联网搜索上海的政策', '解释文章，再查证作者说法'])('requires explicit verification: %s', (question) => {
    expect(evaluateSearchGate({ ...input, question })).toMatchObject({ level: 'required', mustSearch: true });
  });
  it('detects the live request following an article explanation', () => {
    expect(evaluateSearchGate({ ...input, question: '解释文中“最新政策”一词，再告诉我今天上海生效的政策' })).toMatchObject({
      level: 'required', mustSearch: true, freshness: 'day',
    });
  });
  it('keeps explicit today above a looser freshness preference', () => {
    const gate = evaluateSearchGate({ ...input, freshness: 'any' });
    expect(gate.freshness).toBe('day');
    expect(gate.time).toMatchObject({ from: '2026-10-01T16:00:00.000Z', to: '2026-10-02T15:59:59.999Z' });
  });
  it('keeps latest and current requirements above any freshness', () => {
    const gate = evaluateSearchGate({ ...input, question: '上海最新政策是什么？', freshness: 'any' });
    expect(gate.freshness).toBe('live');
    expect(gate.time.from).toBeUndefined();
    expect(gate.time.to).toBeUndefined();
  });
  it('uses the historical year instead of this month', () => {
    expect(evaluateSearchGate({ ...input, question: '2023 年上海政策是什么？', freshness: 'month' })).toMatchObject({
      level: 'recommended', freshness: 'any',
      time: { from: '2022-12-31T16:00:00.000Z', to: '2023-12-31T15:59:59.999Z' },
    });
  });
  it.each(['最新版本是什么？', '现在价格多少？', '那家公司最近的政策是什么？', '今年初前后的上海政策是什么？'])('requests clarification for underspecified scope: %s', (question) => {
    const gate = evaluateSearchGate({ ...input, question });
    expect(gate.level).toBe('ambiguous');
    expect(gate.mustSearch).toBe(false);
    expect(gate.reasons.length).toBeGreaterThan(0);
  });
  it('force requires search even for an article explanation', () => {
    expect(evaluateSearchGate({ ...input, question: '解释本文', mode: 'force' }).level).toBe('required');
  });
  it('leaves uncertain ordinary questions ambiguous', () => {
    expect(evaluateSearchGate({ ...input, question: '这是什么意思？' }).level).toBe('ambiguous');
  });
  it('recommends external background', () => {
    expect(evaluateSearchGate({ ...input, question: '补充上海政策的背景资料' }).level).toBe('recommended');
  });
  it('parses explicit date ranges', () => {
    expect(evaluateSearchGate({ ...input, question: '查证2023-02-01至2023-03-01上海政策' }).time).toMatchObject({
      from: '2023-01-31T16:00:00.000Z', to: '2023-03-01T15:59:59.999Z',
    });
  });
  it.each(['查证2023-02-30上海政策', '查证2024-05-01至2023-05-01上海政策'])('does not fabricate invalid dates: %s', (question) => {
    const gate = evaluateSearchGate({ ...input, question });
    expect(gate.level).toBe('ambiguous');
    expect(gate.time.from).toBeUndefined();
  });
  it.each(['查证2023年2月1日至3月1日上海政策', '查证2023年2月至2023年3月上海政策', '查证2023/02/30上海政策', '今天和2023年上海政策有什么不同？', '查证2023年初前后的上海政策', '查证2023年3月前后的上海政策'])('clarifies unsupported compound dates: %s', (question) => {
    const gate = evaluateSearchGate({ ...input, question });
    expect(gate.level).toBe('ambiguous');
    expect(gate.time.from).toBeUndefined();
  });
});
describe('time context', () => {
  it('subtracts calendar days across a month boundary', () => {
    expect(buildTimeContext(input.now, input.timeZone, 'week')).toMatchObject({
      localDate: '2026-10-02', from: '2026-09-25T16:00:00.000Z', to: '2026-10-02T15:59:59.999Z',
    });
  });
  it.each([
    ['2026-03-08T18:00:00Z', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z'],
    ['2026-11-01T18:00:00Z', '2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z'],
  ])('honors DST for %s', (now, from, to) => {
    expect(buildTimeContext(new Date(now), 'America/New_York', 'day')).toMatchObject({ from, to });
  });
  it('uses historical offsets for historical ranges', () => {
    expect(buildTimeContext(input.now, 'America/New_York', 'month', { from: '2023-07-01', to: '2023-07-31' })).toMatchObject({
      from: '2023-07-01T04:00:00.000Z', to: '2023-08-01T03:59:59.999Z',
    });
  });
  it('uses calendar month length rather than 30 days', () => {
    expect(buildTimeContext(new Date('2024-03-31T12:00:00Z'), 'UTC', 'month').from).toBe('2024-02-29T00:00:00.000Z');
  });
  it('does not invent a range for any freshness', () => {
    expect(buildTimeContext(input.now, input.timeZone, 'any').from).toBeUndefined();
  });
  it('rejects an invalid timezone rather than claiming an arbitrary timezone', () => {
    expect(() => buildTimeContext(input.now, 'Not/AZone', 'day')).toThrow();
  });
});
