import { describe, expect, it } from 'vitest';
import { applyAssessment, assertLedgerRun, recordReads, recordSearch } from '../src/core/search/evidence';
import { queryChange, queryKey } from '../src/core/search/query';
import type { EvidenceLedger, SearchAction, SearchBatch } from '../src/core/search/agent-types';
import { snapshotFixture } from './helpers/research';

const action: SearchAction = { type: 'search_web', query: '配送  试点', purpose: 'fact_check', freshness: 'any', language: 'zh-CN', domains: [], maxResults: 5 };
const batch: SearchBatch = { status: 'ok', results: [{ title: '试点', url: 'https://news.cn/pilot#first', snippet: '覆盖三个团队。' }], provider: 'bocha', retrievedAt: '2026-10-01T08:00:00.000Z', warnings: ['provider_host_fallback'] };
const empty = (): EvidenceLedger => ({ runId: 'r1', sources: [], attempts: [], assessment: null });
const gate = snapshotFixture().gate;
const search = () => recordSearch(empty(), action, batch, '核查范围', undefined, gate);

describe('meaningful query strategies', () => {
  it('normalizes NFKC, whitespace and sorted domains while preserving query structure', () => {
    expect(queryKey({ ...action, query: ' Ａ 配送  试点 ', domains: ['NEWS.CN', 'gov.cn'] }))
      .toBe(queryKey({ ...action, query: 'A 配送 试点', domains: ['gov.cn', 'news.cn'] }));
    expect(queryKey({ ...action, query: '"配送 试点"' })).not.toBe(queryKey(action));
    expect(queryKey({ ...action, query: 'New York' })).not.toBe(queryKey({ ...action, query: 'NewYork' }));
    expect(queryKey({ ...action, query: '配送 2025' })).not.toBe(queryKey({ ...action, query: '配送 2026' }));
  });
  it.each([' 配送 试点 ', '试点 配送', '配送 试点 最新', '配送 试点 latest', '最新配送 试点', '配送 试点最新'])('rejects cosmetic change %s', (query) => {
    expect(queryChange(action, { ...action, query }).meaningful).toBe(false);
  });
  it('identifies changed date, domain, language and substantive wording', () => {
    expect(queryChange(action, { ...action, freshness: 'week', domains: ['gov.cn'] })).toEqual({ meaningful: true, dimensions: ['domain', 'time'] });
    expect(queryChange(action, { ...action, query: '配送 试点 2026-10-01' }).dimensions).toContain('time');
    expect(queryChange(action, { ...action, language: 'en' }).dimensions).toContain('language');
    expect(queryChange(action, { ...action, query: '配送 试点 覆盖地区' }).meaningful).toBe(true);
    expect(queryChange(action, { ...action, query: '"上海" 配送 试点' }).dimensions).toContain('entity');
    expect(queryChange(action, { ...action, purpose: 'latest', maxResults: 10 }).meaningful).toBe(false);
  });
});

describe('evidence ledger', () => {
  it('allocates above the highest sparse checkpoint index and remains valid for the next mutation', () => {
    const sparse: EvidenceLedger = { ...empty(), sources: [{ ...search().sources[0]!, sourceId: 'sr_r1_2' }] };
    const result = recordSearch(sparse, action, { ...batch, results: [
      { ...batch.results[0]!, url: 'https://news.cn/new' },
      { ...batch.results[0]!, url: 'https://news.cn/another' },
    ] }, '恢复后核查');
    expect(result.sources.map(source => source.sourceId)).toEqual(['sr_r1_2', 'sr_r1_3', 'sr_r1_4']);
    expect(result.attempts[0]!.sourceIds).toEqual(['sr_r1_3', 'sr_r1_4']);
    expect(() => assertLedgerRun(result, 'r1')).not.toThrow();
    expect(recordReads(result, []).sources.map(source => source.sourceId)).toEqual(['sr_r1_2', 'sr_r1_3', 'sr_r1_4']);
    expect(sparse.sources.map(source => source.sourceId)).toEqual(['sr_r1_2']);
  });
  it.each(['9007199254740992', '99999999999999999999999999999999999999'])('rejects unsafe numeric checkpoint index %s', (index) => {
    const ledger = { ...empty(), sources: [{ ...search().sources[0]!, sourceId: `sr_r1_${index}` }] };
    expect(() => assertLedgerRun(ledger)).toThrow();
  });
  it('allows the last safe index allocation but rejects the next without mutating the checkpoint', () => {
    const ledger = { ...empty(), sources: [{ ...search().sources[0]!, sourceId: 'sr_r1_9007199254740990' }] };
    const result = recordSearch(ledger, action, { ...batch, results: [{ ...batch.results[0]!, url: 'https://news.cn/new' }] }, '恢复后核查');
    expect(result.sources[1]!.sourceId).toBe('sr_r1_9007199254740991');
    expect(() => assertLedgerRun(result)).not.toThrow();
    expect(() => recordSearch(result, { ...action, domains: ['news.cn'] }, { ...batch, results: [{ ...batch.results[0]!, url: 'https://news.cn/another' }] }, '索引耗尽')).toThrow();
    expect(result.sources.map(source => source.sourceId)).toEqual(['sr_r1_9007199254740990', 'sr_r1_9007199254740991']);
  });
  it.each(['attempt', 'assessment_source', 'assessment_conflict'] as const)('rejects foreign and unknown IDs in %s provenance before every mutation', (field) => {
    for (const id of ['sr_other_1', 'sr_r1_99']) {
      const ledger = search();
      const assessment = { sources: [{ sourceId: 'sr_r1_1', relevant: true, supportedAspects: ['团队'], reason: '直接支持' }], missing: [], conflicts: [] };
      ledger.assessment = structuredClone(assessment);
      if (field === 'attempt') ledger.attempts[0]!.sourceIds.push(id);
      else if (field === 'assessment_source') ledger.assessment.sources[0]!.sourceId = id;
      else ledger.assessment.conflicts = [{ sourceIds: ['sr_r1_1', id], description: '未核验冲突' }];
      expect(() => assertLedgerRun(ledger, 'r1')).toThrow();
      expect(() => recordSearch(ledger, { ...action, domains: ['news.cn'] }, batch, '恢复后核查')).toThrow();
      expect(() => recordReads(ledger, [])).toThrow();
      expect(() => applyAssessment(ledger, assessment)).toThrow();
    }
  });
  it('merges canonical URLs without losing snippets, attempts or bounded provider fallback history', () => {
    const first = search();
    const next = recordSearch(first, { ...action, domains: ['news.cn'] }, { ...batch, results: [{ ...batch.results[0]!, url: 'https://news.cn/pilot#second', snippet: '位于上海。' }] }, '核查地区', undefined, gate);
    expect(next.sources).toHaveLength(1);
    expect(next.sources[0]).toMatchObject({ sourceId: 'sr_r1_1', url: 'https://news.cn/pilot', domain: 'news.cn', attempts: [1, 2], publishedAt: null, dateStatus: 'date_unknown' });
    expect(next.sources[0]!.snippet).toContain('覆盖三个团队。');
    expect(next.sources[0]!.snippet).toContain('位于上海。');
    expect(next.sources[0]!.warnings).toContain('provider_host_fallback');
    expect(first.sources[0]!.attempts).toEqual([1]);
    expect(next.attempts[1]!.sourceIds).toEqual(['sr_r1_1']);
  });
  it('permits only the immediate single identical transient retry and counts it', () => {
    const first = recordSearch(empty(), action, { ...batch, status: 'transient', results: [] }, '传输失败');
    const retried = recordSearch(first, action, { ...batch, status: 'transient', results: [] }, '传输重试', 1);
    expect(retried.attempts).toHaveLength(2);
    expect(retried.attempts[1]!.retryOf).toBe(1);
    expect(() => recordSearch(retried, action, batch, '再次重试', 2)).toThrow();
    expect(() => recordSearch(first, action, batch, '无重试归属')).toThrow();
    expect(() => recordSearch(first, { ...action, query: '试点 配送' }, batch, '伪重试', 1)).toThrow();
    expect(() => recordSearch(first, { ...action, maxResults: 10 }, batch, '更改请求参数', 1)).toThrow();
  });
  it('keeps fallback and blocked-URL diagnostics even when a batch has no usable sources', () => {
    const ledger = recordSearch(empty(), action, { ...batch, results: [{ ...batch.results[0]!, url: 'http://127.0.0.1/key' }] }, '核查');
    expect(ledger.attempts[0]!.reason).toContain('provider_host_fallback');
    expect(ledger.attempts[0]!.reason).toContain('source_url_blocked');
    expect(ledger.attempts[0]!.reason).not.toContain('127.0.0.1');
  });
  it('keeps conflicting publication metadata unknown after reading instead of upgrading it to fresh', () => {
    const ledger = recordSearch(empty(), action, { ...batch, results: [
      { ...batch.results[0]!, publishedAt: '2026-10-01' },
      { ...batch.results[0]!, publishedAt: '2026-09-01' },
    ] }, '日期核对', undefined, gate);
    expect(ledger.sources[0]!.dateStatus).toBe('date_unknown');
    const read = recordReads(ledger, [{ sourceId: 'sr_r1_1', text: '正文', publishedAt: '2026-10-01', retrievedAt: batch.retrievedAt, status: 'read', warnings: [] }], gate);
    expect(read.sources[0]!.dateStatus).toBe('date_unknown');
  });
  it.each(['empty', 'ok', 'failed'] as const)('requires a new strategy after %s', (status) => {
    const first = recordSearch(empty(), action, { ...batch, status, results: [] }, '没有可用证据');
    expect(() => recordSearch(first, { ...action, query: '配送 试点 最新' }, batch, '补词')).toThrow();
    expect(() => recordSearch(first, action, batch, '伪传输重试', 1)).toThrow();
  });
  it('counts all executions toward five searches and rejects returning to an earlier strategy', () => {
    let ledger = empty();
    for (let i = 0; i < 5; i++) ledger = recordSearch(ledger, { ...action, query: `配送 试点 202${i}` }, batch, '核查年份');
    expect(ledger.attempts).toHaveLength(5);
    expect(() => recordSearch(ledger, { ...action, query: '配送 试点 2026' }, batch, '超限')).toThrow();
    const first = search();
    const second = recordSearch(first, { ...action, domains: ['gov.cn'] }, batch, '官方来源');
    expect(() => recordSearch(second, action, batch, '回到原策略')).toThrow();
  });
  it('blocks unsafe source URLs rather than creating read targets', () => {
    const ledger = recordSearch(empty(), action, { ...batch, results: [{ ...batch.results[0]!, url: 'http://127.0.0.1/key' }] }, '核查');
    expect(ledger.sources).toEqual([]);
    expect(ledger.attempts[0]!.sourceIds).toEqual([]);
  });
  it('uses frozen question scope rather than action freshness or retrieval date', () => {
    const scoped = { ...gate, freshness: 'day' as const };
    const ledger = recordSearch(empty(), action, { ...batch, results: [
      { ...batch.results[0]!, publishedAt: '2026-09-01' },
      { ...batch.results[0]!, url: 'https://news.cn/today', publishedAt: '2026-10-01' },
      { ...batch.results[0]!, url: 'https://news.cn/future', publishedAt: '2026-10-02' },
    ] }, '今天', undefined, scoped);
    expect(ledger.sources.map(s => [s.publishedAt, s.dateStatus])).toEqual([
      ['2026-09-01', 'stale'], ['2026-10-01', 'fresh'], ['2026-10-02', 'date_unknown'],
    ]);
    const historical = { ...gate, freshness: 'any' as const, time: { ...gate.time, from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' } };
    expect(recordSearch(empty(), action, { ...batch, results: [{ ...batch.results[0]!, publishedAt: '2026-09-01' }] }, '历史', undefined, historical).sources[0]!.dateStatus).toBe('fresh');
    expect(recordSearch(empty(), action, { ...batch, results: [{ ...batch.results[0]!, publishedAt: '2020-01-01' }] }, '实时', undefined, gate).sources[0]!.dateStatus).toBe('fresh');
  });
  it('adopts only relevant supported evidence and keeps syndication gaps and conflicts', () => {
    const ledger = recordSearch(search(), { ...action, domains: ['gov.cn'] }, { ...batch, results: [{ ...batch.results[0]!, url: 'https://gov.cn/reprint' }] }, '交叉核对');
    const assessment = { sources: [
      { sourceId: 'sr_r1_1', relevant: true, supportedAspects: ['团队'], reason: '直接资料' },
      { sourceId: 'sr_r1_2', relevant: false, supportedAspects: [], reason: '转载同一稿件，不能算独立支持' },
    ], missing: ['缺少独立核对'], conflicts: [{ sourceIds: ['sr_r1_1', 'sr_r1_2'], description: '时间不一致' }] };
    const adopted = applyAssessment(ledger, assessment);
    expect(adopted.sources.map(s => s.decision)).toEqual(['accepted', 'rejected']);
    expect(adopted.assessment).toEqual(assessment);
    expect(adopted.sources[1]!.reason).toContain('转载');
    expect(() => applyAssessment(ledger, { ...assessment, sources: [assessment.sources[0]!] })).toThrow();
    expect(() => applyAssessment(ledger, { ...assessment, conflicts: [{ sourceIds: ['sr_other_1', 'sr_r1_1'], description: '未知' }] })).toThrow();
  });
  it('records reads separately from adoption and resets adoption when evidence changes', () => {
    const first = applyAssessment(search(), { sources: [{ sourceId: 'sr_r1_1', relevant: true, supportedAspects: ['团队'], reason: '摘要支持' }], missing: [], conflicts: [] });
    const read = recordReads(first, [{ sourceId: 'sr_r1_1', text: '完整正文', publishedAt: '2026-09-01', retrievedAt: '2026-10-01T08:01:00Z', status: 'read', warnings: [] }], { ...gate, freshness: 'day' });
    expect(read.sources[0]).toMatchObject({ content: '完整正文', readStatus: 'read', decision: 'candidate', dateStatus: 'stale', readAt: '2026-10-01T08:01:00Z' });
    expect(read.assessment).toBeNull();
    expect(first.sources[0]!.decision).toBe('accepted');
    expect(() => recordReads(first, [{ sourceId: 'sr_other_1', text: '跨轮内容', publishedAt: null, retrievedAt: batch.retrievedAt, status: 'read', warnings: [] }])).toThrow();
    const mixed = { ...first, sources: [{ ...first.sources[0]!, sourceId: 'sr_other_1' }] };
    expect(() => recordReads(mixed, [{ sourceId: 'sr_other_1', text: '跨轮内容', publishedAt: null, retrievedAt: batch.retrievedAt, status: 'read', warnings: [] }])).toThrow();
  });
});
