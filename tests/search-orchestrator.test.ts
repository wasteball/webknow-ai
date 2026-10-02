import { afterEach, describe, expect, it, vi } from 'vitest';
import { researchSearch } from '../src/core/search/registry';
import { runResearch } from '../src/core/search/orchestrator';
import { checkpointFixture, scriptedDependencies } from './helpers/research';
import { recordSearch } from '../src/core/search/evidence';
import { appError } from '../src/core/errors';
import type { AgentCheckpoint, AgentDependencies, FinishAction, SearchAction, SearchBatch } from '../src/core/search/agent-types';

const start = Date.parse('2026-10-01T08:00:00.000Z');
const signal = () => new AbortController().signal;
const ask = { type: 'ask_user', question: '你指哪一个产品？', reason: 'ambiguous_entity' };
const search: SearchAction = { type: 'search_web', query: 'Atlas release', purpose: 'latest', freshness: 'live', language: 'en', domains: [], maxResults: 5 };
const batch: SearchBatch = { status: 'ok', provider: 'test', retrievedAt: '2026-10-01T08:00:00.000Z', warnings: [],
  results: [{ title: 'Atlas', url: 'https://example.org/release', snippet: 'Atlas 3 is current.', publishedAt: '2026-10-01' }] };
const assessment = { sources: [{ sourceId: 'sr_r1_1', relevant: true, supportedAspects: ['current version'], reason: 'Official release' }], missing: [], conflicts: [] };
const emptyAssessment = { sources: [], missing: ['缺少版本信息'], conflicts: [] };
const finish: FinishAction = { type: 'finish_answer', answer: '根据网络资料，Atlas 3 是当前版本。', source: 'extended', citations: [], references: ['sr_r1_1'], unanswered: [], freshness: 'verified' };
const accept = { decision: 'accept', claims: [{ text: 'Atlas 3 is current.', sourceIds: ['sr_r1_1'] }], missing: [], conflicts: [], freshness: 'verified' };
const unknown: FinishAction = { type: 'finish_answer', answer: '无法确认最新版本。', source: 'unknown', citations: [], references: [], unanswered: ['最新版本'], freshness: 'not_applicable' };
const acceptUnknown = { decision: 'accept', claims: [], missing: [], conflicts: [], freshness: 'not_applicable' };
const run = (deps: AgentDependencies, checkpoint = checkpointFixture(), abortSignal = signal()) => runResearch({ checkpoint, deps, signal: abortSignal });

afterEach(() => vi.useRealTimers());

it('pauses without an open request and resumes the same frozen run with intent visible to both auditors', async () => {
  const deps = scriptedDependencies([ask, search, assessment, finish, accept], { search: vi.fn(async () => batch) });
  deps.callJson = vi.fn(deps.callJson);
  const checkpoint = checkpointFixture();
  checkpoint.snapshot.gate.level = 'ambiguous';
  const paused = await run(deps, checkpoint);
  expect(paused.kind).toBe('waiting');
  expect(deps.search).not.toHaveBeenCalled();
  const result = await runResearch({ checkpoint: paused.checkpoint, deps, signal: signal(), resume: { mode: 'continue', text: 'Atlas 数据库' } });
  expect(result).toMatchObject({ kind: 'finished', degraded: false, answer: finish });
  expect(result.checkpoint.snapshot.identity.runId).toBe('r1');
  expect(result.checkpoint.actions).toBe(3);
  expect(result.checkpoint.deadlineAt).toBe(start + 180_000);
  expect(result.checkpoint.snapshot.question).toBe(checkpoint.snapshot.question);
  expect(result.checkpoint.snapshot.gate).toEqual(checkpoint.snapshot.gate);
  const calls = vi.mocked(deps.callJson).mock.calls;
  for (const index of [1, 2, 3, 4]) expect(JSON.stringify(calls[index]![0])).toContain('Atlas 数据库');
  expect(result.checkpoint.snapshot.clarifications).toEqual([{ question: ask.question, answer: 'Atlas 数据库' }]);
});

it('orders search, fixed assessment, changed query, assessment, read, assessment, finish and answer audit', async () => {
  const order: string[] = [];
  const outputs = [search, assessment, { ...search, query: 'Atlas official version' }, assessment,
    { type: 'read_sources', sourceIds: ['sr_r1_1'], focus: 'version' }, assessment, finish, accept];
  const deps = scriptedDependencies(outputs, {
    search: async (_action, s) => { expect(s.aborted).toBe(false); order.push('search'); return batch; },
    read: async (_ids, _focus, _ledger, s) => { expect(s.aborted).toBe(false); order.push('read'); return [{ sourceId: 'sr_r1_1', status: 'read', text: 'Atlas 3 is current.', publishedAt: '2026-10-01', retrievedAt: batch.retrievedAt, warnings: [] }]; },
  });
  const scripted = deps.callJson;
  deps.callJson = async (messages, s) => { expect(s.aborted).toBe(false); order.push(messages[0]!.content.includes('逐一审查') ? 'assess' : messages[0]!.content.includes('审查 candidate') ? 'audit' : 'action'); return scripted(messages, s); };
  const result = await run(deps);
  expect(result).toMatchObject({ kind: 'finished', degraded: false });
  expect(order).toEqual(['action', 'search', 'assess', 'action', 'search', 'assess', 'action', 'read', 'assess', 'action', 'audit']);
  expect(result.checkpoint.audits).toBe(1);
  expect(result.checkpoint.ledger.sources[0]).toMatchObject({ readStatus: 'read', decision: 'accepted', dateStatus: 'fresh' });
});

it('publishes immutable content-free live ledgers at search, assessment and read transitions', async () => {
  const events: import('../src/core/search/agent-types').AgentEvent[] = [];
  const deps = scriptedDependencies([search, assessment, { type: 'read_sources', sourceIds: ['sr_r1_1'], focus: 'version' }, assessment, finish, accept], {
    search: async () => batch,
    read: async () => [{ sourceId: 'sr_r1_1', status: 'read', text: 'PRIVATE_BODY', publishedAt: '2026-10-01', retrievedAt: batch.retrievedAt, warnings: [] }],
    onEvent: event => { events.push(event); },
  });
  await run(deps);
  expect(events.find(e => e.phase === 'searching')).toMatchObject({ searches: 1, details: { attempts: [{ action: search, status: 'pending' }] } });
  const checking = events.filter(e => e.phase === 'checking');
  expect(checking[0]).toMatchObject({ details: { attempts: [{ action: search, status: 'ok' }], sources: [{ decision: 'candidate', readStatus: 'not_read' }] } });
  expect(events.find(e => e.phase === 'reading')).toMatchObject({ details: { sources: [{ decision: 'accepted', readStatus: 'not_read' }] } });
  expect(checking[1]).toMatchObject({ details: { sources: [{ readStatus: 'read' }] } });
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_BODY|answerPolicy|checkpoint|根据网络资料/);
});

it('closes a no-gain wording family despite changing raw queries and adding URLs', async () => {
  const deps = scriptedDependencies([], { search: vi.fn(async (action) => ({ ...batch, results: [{ ...batch.results[0]!, url: `https://example.org/${action.query}` }] })) });
  let actions = 0;
  deps.callJson = async messages => {
    if (messages[0]!.content.includes('逐一审查')) {
      const payload = JSON.parse(messages[1]!.content);
      return { ...emptyAssessment, sources: payload.sources.map((s: { sourceId: string }) => ({ sourceId: s.sourceId, relevant: true, supportedAspects: [], reason: 'No actual support' })) };
    }
    return { ...search, query: `query${++actions}` };
  };
  const result = await run(deps);
  expect(result).toMatchObject({ kind: 'finished', degraded: true, answer: { source: 'unknown' } });
  expect(deps.search).toHaveBeenCalledTimes(3);
  expect(Object.values(result.checkpoint.noGainByStrategy)).toContain(2);
  expect(result.checkpoint.ledger.attempts[1]!.strategyKey).toBe(result.checkpoint.ledger.attempts[2]!.strategyKey);
  expect(JSON.stringify(result.checkpoint.noGainByStrategy)).not.toMatch(/query\d/);
  expect(result.checkpoint.actions).toBeLessThanOrEqual(12);
});

it.each([['deep', 5, 12, 3], ['quick', 3, 8, 2]] as const)('bounds %s searches, actions and answer audits separately', async (depth, searches, actions, audits) => {
  const checkpoint = checkpointFixture(); checkpoint.snapshot.settings.depth = depth;
  let index = 0;
  const deps = scriptedDependencies([], { search: vi.fn(async () => batch) });
  deps.callJson = async messages => messages[0]!.content.includes('逐一审查') ? assessment : { ...search, query: `version${index}`, purpose: ['latest', 'fact_check', 'compare', 'background', 'article_gap'][index++ % 5] };
  const result = await run(deps, checkpoint);
  expect(deps.search).toHaveBeenCalledTimes(searches);
  expect(result.checkpoint.actions).toBe(actions);
  const cp = checkpointFixture(); cp.snapshot.settings.depth = depth;
  const d = scriptedDependencies(Array.from({ length: 10 }, () => [unknown, { ...acceptUnknown, decision: 'revise', missing: ['需要说明限制'] }]).flat());
  const revised = await run(d, cp);
  expect(revised.checkpoint.audits).toBe(audits);
  expect(revised).toMatchObject({ kind: 'finished', degraded: true, answer: { answer: '这次没有核验成功' } });
});

it('permits a single identical transient retry and counts it as a search', async () => {
  const deps = scriptedDependencies([search, emptyAssessment, search, assessment, finish, accept]);
  deps.search = vi.fn().mockResolvedValueOnce({ ...batch, status: 'transient', results: [] }).mockResolvedValueOnce(batch);
  const result = await run(deps);
  expect(result).toMatchObject({ kind: 'finished', degraded: false });
  expect(result.checkpoint.ledger.attempts.map(a => a.retryOf)).toEqual([undefined, 1]);
});

it.each([true, false])('recovers a composed registry timeout (abort-aware: %s) with one identical retry', async abortAware => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    signals.push(init!.signal!);
    if (signals.length === 1) return new Promise<Response>((_resolve, reject) => {
      if (abortAware) init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    });
    return new Response(JSON.stringify({ results: [{ title: 'Atlas', url: 'https://example.org/release', content: 'Atlas 3 is current.' }] }));
  });
  const deps = scriptedDependencies([search, emptyAssessment, search, assessment, { ...finish, freshness: 'date_unknown' }, { ...accept, freshness: 'date_unknown' }], {
    now: () => Date.now(),
    search: async (action, signal) => {
      // Production performs asynchronous configuration/permission checks before registry entry.
      await Promise.resolve();
      return researchSearch({ providerId: 'tavily', config: { apiKey: 'synthetic' }, action, signal, now: () => new Date(), fetchImpl });
    },
  });
  const promise = run(deps);
  await vi.advanceTimersByTimeAsync(15_000);
  const result = await promise;
  expect(signals[0]?.aborted).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ kind: 'finished', answer: { answer: finish.answer } });
  expect(result.checkpoint.ledger.attempts.map(a => [a.status, a.retryOf])).toEqual([['transient', undefined], ['ok', 1]]);
  expect(result.checkpoint.deadlineAt).toBe(start + 180_000);
});

it('bounds repeated nonsettling searches to one identical retry before an audited degradation', async () => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const signals: AbortSignal[] = [];
  const deps = scriptedDependencies([search, emptyAssessment, search, emptyAssessment, search, unknown, acceptUnknown], {
    now: () => Date.now(), search: vi.fn(async (_a, signal) => { signals.push(signal); return new Promise<never>(() => {}); }),
  });
  const promise = run(deps);
  await vi.advanceTimersByTimeAsync(30_000);
  const result = await promise;
  expect(result).toMatchObject({ kind: 'finished', answer: unknown });
  expect(signals).toHaveLength(2); expect(signals.every(s => s.aborted)).toBe(true);
  expect(result.checkpoint.ledger.attempts.map(a => [a.status, a.retryOf])).toEqual([['transient', undefined], ['transient', 1]]);
});

it('allows only one global format repair across pauses', async () => {
  const deps = scriptedDependencies([{ invalid: true }, ask, { invalid: true }, unknown, acceptUnknown]);
  deps.callJson = vi.fn(deps.callJson);
  const paused = await run(deps);
  expect(paused.checkpoint.formatRepairs).toBe(1);
  const result = await runResearch({ checkpoint: paused.checkpoint, deps, signal: signal(), resume: { mode: 'continue', text: 'Atlas' } });
  expect(result).toMatchObject({ kind: 'finished', degraded: true });
  expect(deps.callJson).toHaveBeenCalledTimes(3);
});

it('cannot verify a required search after failed search or blocked permission', async () => {
  const deps = scriptedDependencies([search, emptyAssessment, { ...unknown, freshness: 'verified' }, unknown, acceptUnknown]);
  const result = await run(deps);
  expect(result).toMatchObject({ kind: 'finished', answer: unknown, degraded: true });
  const cp = checkpointFixture(); cp.snapshot.gate.canSearch = false;
  const d = scriptedDependencies([search, unknown, acceptUnknown], { search: vi.fn() });
  await run(d, cp);
  expect(d.search).not.toHaveBeenCalled();
});

it('resumes article-only with no usable web evidence and explicit unverified disclosure', async () => {
  const cp = checkpointFixture(); cp.ledger = recordSearch(cp.ledger, search, batch, '', undefined, cp.snapshot.gate);
  const deps = scriptedDependencies([ask, search, { ...unknown, source: 'original', citations: ['b_0'], answer: '试点只有三个团队。' }, acceptUnknown], { search: vi.fn() });
  const paused = await run(deps, cp);
  const result = await runResearch({ checkpoint: paused.checkpoint, deps, signal: signal(), resume: { mode: 'article', text: '只看文章' } });
  expect(result).toMatchObject({ kind: 'finished', degraded: true, answer: { references: [], freshness: 'not_applicable' } });
  if (result.kind === 'finished') expect(result.answer.answer).toContain('未联网核验');
  expect(result.checkpoint.ledger.sources).toEqual([]);
  expect(result.checkpoint.ledger.attempts).toHaveLength(1);
  expect(result.checkpoint.snapshot.gate.canSearch).toBe(false);
  expect(deps.search).not.toHaveBeenCalled();
});

it('rejects mixed-run evidence before any dependency transmission', async () => {
  const cp = checkpointFixture(); cp.ledger.runId = 'another';
  const deps = scriptedDependencies([unknown], { callJson: vi.fn(), search: vi.fn() });
  await expect(run(deps, cp)).rejects.toMatchObject({ code: 'BAD_OUTPUT' });
  expect(deps.callJson).not.toHaveBeenCalled();
});

it.each([['deep', 5], ['quick', 2]] as const)('bounds %s reads and clips each body and total body even for an overreturning dependency', async (depth, pages) => {
  const cp = checkpointFixture(); cp.snapshot.settings.depth = depth;
  const sources = Array.from({ length: 6 }, (_, i) => ({ ...batch.results[0]!, url: `https://example.org/source${i}` }));
  const all = { sources: sources.map((_, i) => ({ ...assessment.sources[0]!, sourceId: `sr_r1_${i + 1}` })), missing: [], conflicts: [] };
  const ids = Array.from({ length: pages }, (_, i) => `sr_r1_${i + 1}`);
  const deps = scriptedDependencies([{ ...search, maxResults: 6 }, all, { type: 'read_sources', sourceIds: ids, focus: 'version' }, all,
    { type: 'read_sources', sourceIds: [`sr_r1_${pages + 1}`], focus: 'version' }, finish, accept], {
    search: async () => ({ ...batch, results: sources }),
    read: vi.fn(async (requested: string[]) => requested.map(sourceId => ({ sourceId, text: 'x'.repeat(20_000), status: 'read' as const,
      publishedAt: '2026-10-01', retrievedAt: batch.retrievedAt, warnings: [] }))),
  });
  const result = await run(deps, cp);
  expect(result).toMatchObject({ kind: 'finished', degraded: false });
  expect(result.checkpoint.readIds).toHaveLength(pages);
  expect(deps.read).toHaveBeenCalledTimes(1);
  const bodies = result.checkpoint.ledger.sources.map(source => source.content?.length ?? 0);
  expect(Math.max(...bodies)).toBe(12_000);
  expect(bodies.reduce((a, b) => a + b, 0)).toBe(depth === 'deep' ? 40_000 : 24_000);
  expect(result.checkpoint.ledger.sources[0]!.warnings).toContain('source_truncated');
});

it('keeps the original date scope for old background while accepting verified current claims', async () => {
  const cp = checkpointFixture(); cp.snapshot.gate.freshness = 'day';
  cp.snapshot.gate.time.from = '2026-10-01'; cp.snapshot.gate.time.to = '2026-10-01';
  const all = { ...assessment, sources: [...assessment.sources, { ...assessment.sources[0]!, sourceId: 'sr_r1_2', supportedAspects: ['historical version'] }] };
  const deps = scriptedDependencies([{ ...search, freshness: 'any' }, all, { ...finish, references: ['sr_r1_1', 'sr_r1_2'] },
    { ...accept, claims: [...accept.claims, { text: 'Old version was 2 in 2020.', sourceIds: ['sr_r1_2'], temporalScope: 'background' }] }], {
    search: async () => ({ ...batch, results: [...batch.results, { ...batch.results[0]!, url: 'https://example.org/history', snippet: 'Version 2 in 2020.', publishedAt: '2020-01-01' }] }),
  });
  const result = await run(deps, cp);
  expect(result).toMatchObject({ kind: 'finished', degraded: false });
  expect(result.checkpoint.ledger.sources.map(s => s.dateStatus)).toEqual(['fresh', 'stale']);
});

it('repairs a finish citing known unadopted evidence without returning its draft', async () => {
  const deps = scriptedDependencies([search, { ...assessment, sources: [{ ...assessment.sources[0]!, relevant: false }] }, finish, unknown, acceptUnknown], { search: async () => batch });
  const result = await run(deps);
  expect(result).toMatchObject({ kind: 'finished', answer: unknown, degraded: true });
  expect(result.checkpoint.audits).toBe(1);
});

it('retains article-only disclosure when the draft has the maximum allowed length', async () => {
  const cp = checkpointFixture(); cp.waiting = ask as AgentCheckpoint['waiting'];
  const deps = scriptedDependencies([{ ...unknown, answer: '字'.repeat(8000) }, acceptUnknown]);
  deps.callJson = vi.fn(deps.callJson);
  const result = await runResearch({ checkpoint: cp, deps, signal: signal(), resume: { mode: 'article', text: '只看文章' } });
  expect(result.kind).toBe('finished');
  if (result.kind === 'finished') expect(result.answer.answer).toContain('未联网核验');
  expect(JSON.stringify(vi.mocked(deps.callJson).mock.calls[1]![0])).toContain('未联网核验');
});

it('keeps late reader mutation out of the returned fallback checkpoint', async () => {
  vi.useFakeTimers();
  let mutate!: () => void;
  const deps = scriptedDependencies([search, assessment, { type: 'read_sources', sourceIds: ['sr_r1_1'], focus: 'version' }], {
    search: async () => batch,
    read: async (_ids, _focus, ledger) => { mutate = () => { ledger.attempts.push({ ...ledger.attempts[0]!, id: 99 }); }; return new Promise(() => {}); },
  });
  const promise = run(deps);
  await vi.advanceTimersByTimeAsync(90_000);
  const result = await promise;
  mutate();
  expect(result.checkpoint.ledger.attempts).toHaveLength(1);
});

it('preserves counters across a pause and does not call action caller after the action cap', async () => {
  const cp = checkpointFixture(); cp.actions = 11;
  const deps = scriptedDependencies([ask]); deps.callJson = vi.fn(deps.callJson);
  const paused = await run(deps, cp);
  const result = await runResearch({ checkpoint: paused.checkpoint, deps, signal: signal(), resume: { mode: 'continue', text: 'Atlas' } });
  expect(result).toMatchObject({ kind: 'finished', degraded: true, checkpoint: { actions: 12 } });
  expect(deps.callJson).toHaveBeenCalledTimes(1);
});

it('blocks malformed actions after one repair without looping through the remaining action cap', async () => {
  const deps = scriptedDependencies([{}, {}, {}, {}]); deps.callJson = vi.fn(deps.callJson);
  const result = await run(deps);
  expect(result).toMatchObject({ kind: 'finished', degraded: true, checkpoint: { formatRepairs: 1 } });
  expect(deps.callJson).toHaveBeenCalledTimes(2);
});

it.each(['aspect', 'date', 'body'] as const)('resets no-gain only when %s support improves', async improvement => {
  const outputs: unknown[] = [search, assessment, { ...search, query: 'Atlas official' }, assessment];
  const changed = improvement === 'aspect' ? { ...assessment, sources: [{ ...assessment.sources[0]!, supportedAspects: ['current version', 'release channel'] }] } : assessment;
  if (improvement === 'body') outputs.push({ type: 'read_sources', sourceIds: ['sr_r1_1'], focus: 'version' }, changed);
  else outputs.push({ ...search, query: 'Atlas release channel' }, changed);
  outputs.push(finish, accept);
  let searches = 0;
  const deps = scriptedDependencies(outputs, {
    search: async () => ({ ...batch, results: [{ ...batch.results[0]!, publishedAt: improvement === 'date' && ++searches < 3 ? undefined : '2026-10-01' }] }),
    read: async () => [{ sourceId: 'sr_r1_1', status: 'read', text: 'Atlas 3 is current.', publishedAt: '2026-10-01', retrievedAt: batch.retrievedAt, warnings: [] }],
  });
  const result = await run(deps);
  expect(result).toMatchObject({ kind: 'finished', degraded: false });
  const family = result.checkpoint.ledger.attempts.at(-1)!.strategyKey;
  expect(result.checkpoint.noGainByStrategy[family]).toBe(0);
});

it('allows a different retrieval dimension after the wording family closes', async () => {
  const outputs = [search, emptyAssessment, { ...search, query: 'Atlas official' }, emptyAssessment,
    { ...search, query: 'Atlas stable release' }, emptyAssessment,
    { ...search, query: 'Atlas stable release', domains: ['example.org'] }, assessment, finish, accept];
  let searches = 0;
  const deps = scriptedDependencies(outputs, { search: vi.fn(async () => ++searches < 4 ? { ...batch, status: 'empty' as const, results: [] } : batch) });
  const result = await run(deps);
  expect(result).toMatchObject({ kind: 'finished', degraded: false });
  expect(deps.search).toHaveBeenCalledTimes(4);
  expect(Object.values(result.checkpoint.noGainByStrategy)).toContain(2);
});

it('does not return an accepted answer after the final event handler stops the run', async () => {
  const controller = new AbortController();
  const deps = scriptedDependencies([unknown, acceptUnknown], { onEvent: event => { if (event.reason === 'complete') controller.abort(); } });
  await expect(run(deps, checkpointFixture(), controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
});

it('does not renew quick/deep deadline on resume and preserves expired waiting question', async () => {
  const cp = checkpointFixture(); cp.snapshot.settings.depth = 'quick'; cp.deadlineAt = start + 999_999;
  const deps = scriptedDependencies([ask]);
  const paused = await run(deps, cp);
  expect(paused.checkpoint.deadlineAt).toBe(start + 90_000);
  deps.now = () => start + 90_001; deps.callJson = vi.fn();
  const expired = await runResearch({ checkpoint: paused.checkpoint, deps, signal: signal(), resume: { mode: 'continue', text: 'late' } });
  expect(expired).toMatchObject({ kind: 'finished', degraded: true, checkpoint: { waiting: ask } });
  expect(deps.callJson).not.toHaveBeenCalled();
  expect(expired.checkpoint.snapshot.clarifications).toBeUndefined();
});

describe('async boundaries', () => {
  it.each((['action', 'repair', 'search', 'assessment', 'read', 'answer audit'] as const).flatMap(phase =>
    (['timeout', 'external abort'] as const).map(cause => ({ phase, cause }))))(
    'preserves $cause authority for an abort-aware $phase dependency with no subsequent calls', async ({ phase, cause }) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const cp = checkpointFixture(); cp.deadlineAt = start + 100;
      const outputs = phase === 'action' ? [] : phase === 'repair' ? [{}] : phase === 'read'
        ? [search, assessment, { type: 'read_sources', sourceIds: ['sr_r1_1'], focus: 'version' }]
        : phase === 'answer audit' ? [search, assessment, finish] : [search];
      const deps = scriptedDependencies(outputs, { search: async () => batch });
      let entered!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      let captured: AbortSignal | undefined;
      let countsOnAbort: number[] | undefined;
      const counts = () => [deps.callJson, deps.search, deps.read, deps.assertCurrent, deps.onEvent]
        .map(fn => vi.mocked(fn).mock.calls.length);
      const pending = (s: AbortSignal) => new Promise<never>((_resolve, reject) => {
        captured = s;
        s.addEventListener('abort', () => {
          countsOnAbort = counts();
          reject(appError('ABORTED', 'transport cancelled'));
        }, { once: true });
        entered();
      });
      const scripted = deps.callJson;
      let jsonCalls = 0;
      if (phase === 'search') deps.search = (_action, s) => pending(s);
      else if (phase === 'read') deps.read = (_ids, _focus, _ledger, s) => pending(s);
      else deps.callJson = (m, s) => jsonCalls++ >= outputs.length ? pending(s) : scripted(m, s);
      deps.callJson = vi.fn(deps.callJson); deps.search = vi.fn(deps.search); deps.read = vi.fn(deps.read);
      deps.assertCurrent = vi.fn(deps.assertCurrent); deps.onEvent = vi.fn(deps.onEvent);
      const settled = run(deps, cp, controller.signal).then(value => ({ value }), error => ({ error }));
      await reached;
      if (cause === 'timeout') await vi.advanceTimersByTimeAsync(100);
      else controller.abort();
      const result = await settled;
      if (cause === 'timeout') {
        expect(controller.signal.aborted).toBe(false);
        expect(result).toMatchObject({ value: { kind: 'finished', degraded: true,
          answer: { answer: '这次没有核验成功', source: 'unknown', citations: [], references: [], freshness: 'not_applicable' } } });
      } else expect(result).toMatchObject({ error: { code: 'ABORTED' } });
      expect(captured?.aborted).toBe(true);
      expect(counts()).toEqual(countsOnAbort);
      expect(vi.getTimerCount()).toBe(0);
    });

  const phases = ['action', 'repair', 'search', 'assessment', 'read', 'answer audit', 'clarification', 'assertCurrent'] as const;
  it.each(phases)('aborts %s even when dependency ignores signal and suppresses late writes/events', async phase => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<unknown>(resolve => { release = resolve; });
    let captured: AbortSignal | undefined;
    const hang = (s?: AbortSignal) => { captured = s; entered(); return pending; };
    const outputs = phase === 'repair' ? [{}] : phase === 'read' ? [search, assessment, { type: 'read_sources', sourceIds: ['sr_r1_1'], focus: 'version' }] : phase === 'answer audit' ? [search, assessment, finish] : phase === 'search' || phase === 'assessment' ? [search] : [];
    const deps = scriptedDependencies(outputs, { search: async () => batch, onEvent: vi.fn() });
    const scripted = deps.callJson; let count = 0;
    if (phase === 'search') deps.search = (_a, s) => hang(s) as Promise<SearchBatch>;
    else if (phase === 'read') deps.read = (_i, _f, _l, s) => hang(s) as ReturnType<AgentDependencies['read']>;
    else if (phase === 'assertCurrent') deps.assertCurrent = () => hang() as Promise<void>;
    else deps.callJson = (m, s) => count++ >= outputs.length ? hang(s) : scripted(m, s);
    const cp = checkpointFixture();
    if (phase === 'clarification') cp.waiting = ask as AgentCheckpoint['waiting'];
    const controller = new AbortController();
    const promise = runResearch({ checkpoint: cp, deps, signal: controller.signal, ...(phase === 'clarification' ? { resume: { mode: 'continue' as const, text: 'Atlas' } } : {}) });
    const rejected = expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
    await reached;
    controller.abort();
    await rejected;
    if (captured) expect(captured.aborted).toBe(true);
    const eventCount = vi.mocked(deps.onEvent).mock.calls.length;
    release(unknown); await vi.runAllTimersAsync();
    expect(vi.mocked(deps.onEvent).mock.calls).toHaveLength(eventCount);
    expect(cp.actions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['read', 'assessment', 'answer', 'action'] as const)('times out stalled %s to a fixed answer without adopting late output', async phase => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    const pending = (s: AbortSignal): Promise<never> => { captured = s; return new Promise(() => {}); };
    const deps = scriptedDependencies(phase === 'action' ? [] : phase === 'read' ? [search, assessment, { type: 'read_sources', sourceIds: ['sr_r1_1'], focus: 'version' }] : phase === 'answer' ? [search, assessment, finish] : [search], { search: async () => batch });
    if (phase === 'read') deps.read = (_i, _f, _l, s) => pending(s);
    else { const scripted = deps.callJson; deps.callJson = async (m, s) => { try { return await scripted(m, s); } catch { return pending(s); } }; }
    deps.callJson = vi.fn(deps.callJson);
    const promise = run(deps);
    await vi.advanceTimersByTimeAsync(90_000);
    const result = await promise;
    expect(result).toMatchObject({ kind: 'finished', degraded: true, answer: { answer: '这次没有核验成功', citations: [], references: [], freshness: 'not_applicable' } });
    expect(captured?.aborted).toBe(true);
    if (phase === 'read') expect(result.checkpoint.readIds).toEqual(['sr_r1_1']);
    expect(result.checkpoint.ledger.sources.every(s => !('content' in s))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('post-return current-page guard blocks late search evidence and subsequent model calls', async () => {
    let stale = false;
    const deps = scriptedDependencies([search, assessment], {
      search: async () => { stale = true; return batch; },
      assertCurrent: async () => { if (stale) throw appError('STALE_PAGE', 'changed'); },
    });
    deps.callJson = vi.fn(deps.callJson);
    await expect(run(deps)).rejects.toMatchObject({ code: 'STALE_PAGE' });
    expect(deps.callJson).toHaveBeenCalledTimes(1);
  });

  it('checks deadline again after an ignored-signal answer audit returns', async () => {
    let now = start;
    const deps = scriptedDependencies([search, assessment, finish, accept], { search: async () => batch, now: () => now });
    const scripted = deps.callJson;
    deps.callJson = vi.fn(async (m, s) => {
      const value = await scripted(m, s);
      if (m[0]!.content.includes('审查 candidate')) now = start + 180_001;
      return value;
    });
    const result = await run(deps);
    expect(result).toMatchObject({ kind: 'finished', degraded: true, answer: { answer: '这次没有核验成功' } });
    expect(deps.callJson).toHaveBeenCalledTimes(4);
  });

  it('uses the remaining overall deadline instead of restarting a full phase timeout', async () => {
    vi.useFakeTimers();
    const cp = checkpointFixture(); cp.deadlineAt = start + 100;
    let seen: AbortSignal | undefined;
    const deps = scriptedDependencies([search], { search: (_a, s) => { seen = s; return new Promise(() => {}); } });
    const promise = run(deps, cp);
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toMatchObject({ kind: 'finished', degraded: true });
    expect(seen?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks page identity after a rejected dependency before adopting even a fallback', async () => {
    let stale = false;
    const deps = scriptedDependencies([search], {
      search: async () => { stale = true; throw appError('BAD_OUTPUT', 'invalid'); },
      assertCurrent: async () => { if (stale) throw appError('STALE_PAGE', 'changed'); },
    });
    await expect(run(deps)).rejects.toMatchObject({ code: 'STALE_PAGE' });
  });
});
