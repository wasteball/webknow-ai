import { describe, expect, it } from 'vitest';
import { toResearchAnswer } from '../src/core/search/answer';
import type { AgentOutcome, SourceRecord } from '../src/core/search/agent-types';
import type { ChatTurn } from '../src/core/session';
import { checkpointFixture } from './helpers/research';

const source: SourceRecord = { sourceId: 'sr_r1_1', url: 'https://news.cn/pilot', title: '试点', domain: 'news.cn', snippet: '三个团队', content: 'SOURCE BODY MUST NOT PERSIST', provider: 'bocha', attempts: [1], publishedAt: null, retrievedAt: '2026-10-01T08:00:00Z', readStatus: 'read', dateStatus: 'date_unknown', decision: 'accepted', warnings: [] };
function outcome(): Extract<AgentOutcome, { kind: 'finished' }> {
  const checkpoint = checkpointFixture();
  checkpoint.ledger.sources = [source];
  return { kind: 'finished', checkpoint, answer: { type: 'finish_answer', answer: '根据网络资料：三个团队。', source: 'extended', citations: ['b_0'], references: ['sr_r1_1'], unanswered: ['日期未知'], freshness: 'date_unknown' }, degraded: false };
}

describe('verified research answer mapping', () => {
  it('maps source IDs to canonical URLs and keeps legacy string references', () => {
    const result = toResearchAnswer(outcome());
    expect(result).toMatchObject({ source: 'extended', citations: [{ blockId: 'b_0' }], references: ['https://news.cn/pilot'], unanswered: ['日期未知'] });
    expect(result.webReferences).toEqual([{ sourceId: 'sr_r1_1', url: 'https://news.cn/pilot', title: '试点', domain: 'news.cn', publishedAt: null, retrievedAt: '2026-10-01T08:00:00Z', readStatus: 'read' }]);
    const turn: ChatTurn = { id: 'turn', question: '问', at: 1, ...result };
    expect(turn.references[0]).toBe('https://news.cn/pilot');
  });
  it.each(['sr_missing', 'sr_other_1', 'https://evil.cn/manual'])('rejects the entire answer for unknown reference %s', (id) => {
    const value = outcome(); value.answer.references = [id];
    expect(() => toResearchAnswer(value)).toThrow();
  });
  it.each(['candidate', 'rejected'] as const)('rejects a known %s source at completion', (decision) => {
    const value = outcome(); value.checkpoint.ledger.sources = [{ ...source, decision }];
    expect(() => toResearchAnswer(value)).toThrow();
  });
  it('rejects cross-run ledgers and unsafe source hyperlinks', () => {
    const value = outcome(); value.checkpoint.ledger.runId = 'other';
    expect(() => toResearchAnswer(value)).toThrow();
    value.checkpoint.ledger.runId = 'r1'; value.checkpoint.ledger.sources = [{ ...source, url: 'https://name:secret@news.cn/pilot' }];
    expect(() => toResearchAnswer(value)).toThrow();
  });
  it('rejects a cross-run source even if it was mistakenly mixed into the current ledger', () => {
    const value = outcome(); value.checkpoint.ledger.sources = [{ ...source, sourceId: 'sr_other_1' }];
    value.answer.references = ['sr_other_1'];
    expect(() => toResearchAnswer(value)).toThrow();
  });
  it('validates all article IDs before cleaning rather than silently dropping bad citations', () => {
    const value = outcome(); value.answer.citations = ['b_0', 'b_missing'];
    expect(() => toResearchAnswer(value)).toThrow();
  });
  it('requires local non-image evidence for original answers without external references', () => {
    const value = outcome(); value.answer.source = 'original';
    expect(() => toResearchAnswer(value)).toThrow();
    value.answer.references = []; value.answer.citations = [];
    expect(() => toResearchAnswer(value)).toThrow();
    value.answer.citations = ['b_0'];
    expect(toResearchAnswer(value).source).toBe('original');
    value.checkpoint.snapshot.blocks[0]!.role = 'image';
    expect(() => toResearchAnswer(value)).toThrow();
  });
  it('requires external references for extended facts and rejects empty answer content', () => {
    const value = outcome(); value.answer.references = [];
    expect(() => toResearchAnswer(value)).toThrow();
    value.answer.source = 'unknown'; value.answer.answer = '   ';
    expect(() => toResearchAnswer(value)).toThrow();
  });
  it('preserves adopted historical background after scoped freshness auditing', () => {
    const value = outcome(); value.answer.freshness = 'verified';
    value.checkpoint.snapshot.gate.freshness = 'day';
    value.checkpoint.ledger.sources = [{ ...source, publishedAt: '2020-01-01', dateStatus: 'stale' }];
    expect(toResearchAnswer(value).research.freshness).toBe('verified');
  });
  it('deduplicates adopted references and rejects more than five instead of dropping evidence', () => {
    const value = outcome(); value.answer.references.push('sr_r1_1');
    expect(toResearchAnswer(value).webReferences).toHaveLength(1);
    value.checkpoint.ledger.sources = Array.from({ length: 6 }, (_, i) => ({ ...source, sourceId: `sr_r1_${i + 1}`, url: `https://news.cn/${i + 1}` }));
    value.answer.references = value.checkpoint.ledger.sources.map(s => s.sourceId);
    expect(() => toResearchAnswer(value)).toThrow();
  });
  it('allowlists completion summary fields and retains rejected reasons and conflicts without content or credentials', () => {
    const value = outcome();
    value.checkpoint.ledger.sources.push({ ...source, sourceId: 'sr_r1_2', url: 'https://gov.cn/reprint', decision: 'rejected', reason: '转载', content: 'REJECTED BODY' });
    Object.assign(value.checkpoint.ledger.sources[0]!, { apiKey: 'SOURCE_CREDENTIAL' });
    value.checkpoint.ledger.attempts = [{ id: 1, action: { type: 'search_web', query: '试点', purpose: 'fact_check', freshness: 'any', language: 'zh-CN', domains: [], maxResults: 5 }, queryKey: 'query', strategyKey: 'strategy', status: 'ok', reason: '交叉核对', sourceIds: ['sr_r1_1', 'sr_r1_2'], retrievedAt: source.retrievedAt }];
    Object.assign(value.checkpoint.ledger.attempts[0]!.action, { apiKey: 'ACTION_CREDENTIAL' });
    value.checkpoint.ledger.assessment = { sources: [], missing: ['缺少独立来源'], conflicts: [{ sourceIds: ['sr_r1_1', 'sr_r1_2'], description: '时间不同' }] };
    value.degraded = true;
    const result = toResearchAnswer(value);
    expect(result.research.sources[1]).toMatchObject({ decision: 'rejected', reason: '转载' });
    expect(result.research.conflicts).toEqual([{ sourceIds: ['sr_r1_1', 'sr_r1_2'], description: '时间不同' }]);
    expect(result.research.degraded).toBe(true);
    expect(JSON.stringify(result.research)).not.toMatch(/BODY|CREDENTIAL|apiKey|"content"/);
    expect(value.checkpoint.ledger.sources[0]!.content).toBe('SOURCE BODY MUST NOT PERSIST');
  });
});
