import type { EvidenceAssessment, EvidenceLedger, GateResult, SearchAction, SearchBatch, SourceRead } from './agent-types';
import { appError } from '../errors';
import { AGENT_LIMITS } from './agent-limits';
import { AgentActionSchema } from './agent-schema';
import { EvidenceAssessmentSchema } from './auditor';
import { queryKey, strategyKey } from './query';
import { sourcePublishedAt } from './source-extract';
import { publicSourceUrl } from './source-url';
import { publicationDateStatus } from './time';

type Scope = Pick<GateResult, 'freshness' | 'time'>;
const unique = <T>(values: T[]) => [...new Set(values)];
function invalid(): never { throw appError('BAD_OUTPUT', '研究证据或查询策略无效，没有采用。'); }
function sourceIndex(sourceId: string, runId: string): number {
  const prefix = `sr_${runId}_`;
  const tail = sourceId.slice(prefix.length);
  const index = Number(tail);
  if (!sourceId.startsWith(prefix) || !/^[1-9]\d*$/.test(tail) || !Number.isSafeInteger(index)) invalid();
  return index;
}
/** Validates ownership, safe indexes and nested provenance. Call before either resumed auditor input. */
export function assertLedgerRun(ledger: EvidenceLedger, expectedRunId: string = ledger.runId): void {
  const ids = new Set(ledger.sources.map(source => source.sourceId));
  if (ledger.runId !== expectedRunId || !/^[a-zA-Z0-9_-]+$/.test(ledger.runId) ||
    ids.size !== ledger.sources.length) invalid();
  for (const source of ledger.sources) sourceIndex(source.sourceId, ledger.runId);
  const provenance = [
    ...ledger.attempts.flatMap(attempt => attempt.sourceIds),
    ...(ledger.assessment?.sources.map(source => source.sourceId) ?? []),
    ...(ledger.assessment?.conflicts.flatMap(conflict => conflict.sourceIds) ?? []),
  ];
  if (provenance.some(id => !ids.has(id))) invalid();
}

/** Scope is the frozen question gate, not the individual search action's filter. */
export function recordSearch(ledger: EvidenceLedger, action: SearchAction, batch: SearchBatch,
  reason: string, retryOf?: number, scope?: Scope): EvidenceLedger {
  assertLedgerRun(ledger);
  const parsed = AgentActionSchema.safeParse(action);
  if (!parsed.success || parsed.data.type !== 'search_web' || ledger.attempts.length >= AGENT_LIMITS.searches) invalid();
  const request = parsed.data;
  const key = queryKey(request), strategy = strategyKey(request);
  const previous = ledger.attempts.at(-1);
  if (retryOf !== undefined) {
    if (!previous || previous.id !== retryOf || previous.status !== 'transient' ||
      previous.retryOf !== undefined || previous.queryKey !== key || previous.action.maxResults !== request.maxResults) invalid();
  } else if (ledger.attempts.some(attempt => attempt.strategyKey === strategy)) invalid();
  const id = ledger.attempts.length + 1;
  const sources = ledger.sources.map(source => ({ ...source, attempts: [...source.attempts], warnings: [...source.warnings] }));
  let lastSourceIndex = sources.reduce((max, source) => Math.max(max, sourceIndex(source.sourceId, ledger.runId)), 0);
  const sourceIds: string[] = [];
  const diagnostics = [...batch.warnings];
  let changed = false;
  // Provider fallback happens inside one bounded batch. Its warnings are retained, not extra attempts.
  for (const result of batch.status === 'ok' ? batch.results.slice(0, request.maxResults) : []) {
    const url = publicSourceUrl(result.url);
    if (!url) { diagnostics.push('source_url_blocked'); continue; }
    const publishedAt = sourcePublishedAt(result.publishedAt);
    let source = sources.find(item => item.url === url.href);
    if (!source) {
      if (!Number.isSafeInteger(++lastSourceIndex)) invalid();
      source = { sourceId: `sr_${ledger.runId}_${lastSourceIndex}`, url: url.href, domain: url.hostname,
        title: result.title, snippet: result.snippet, provider: batch.provider, attempts: [id], publishedAt,
        retrievedAt: batch.retrievedAt, readStatus: 'not_read', decision: 'candidate',
        dateStatus: publicationDateStatus(publishedAt, scope), warnings: [...batch.warnings] };
      sources.push(source); changed = true;
    } else {
      const snippets = unique([source.snippet, source.snippet.includes(result.snippet) ? '' : result.snippet].filter(Boolean));
      const snippet = snippets.join('\n');
      const newPublication = source.publishedAt ?? publishedAt;
      const dateConflict = !!source.publishedAt && !!publishedAt && source.publishedAt !== publishedAt;
      if (snippet !== source.snippet || newPublication !== source.publishedAt || dateConflict) {
        source.decision = 'candidate'; delete source.reason; changed = true;
      }
      source.snippet = snippet;
      source.publishedAt = newPublication;
      source.attempts = unique([...source.attempts, id]);
      source.warnings = unique([...source.warnings, ...batch.warnings, ...(dateConflict ? ['source_publication_conflict'] : [])]);
      source.dateStatus = source.warnings.includes('source_publication_conflict')
        ? 'date_unknown' : publicationDateStatus(source.publishedAt, scope);
    }
    sourceIds.push(source.sourceId);
  }
  return { runId: ledger.runId, sources, assessment: changed ? null : ledger.assessment,
    attempts: [...ledger.attempts, { id, action: request, queryKey: key, strategyKey: strategy, status: batch.status,
      reason: [reason, ...unique(diagnostics)].filter(Boolean).join('\n'),
      ...(retryOf === undefined ? {} : { retryOf }), sourceIds: unique(sourceIds), retrievedAt: batch.retrievedAt }] };
}

export function recordReads(ledger: EvidenceLedger, reads: SourceRead[], scope?: Scope): EvidenceLedger {
  assertLedgerRun(ledger);
  if (new Set(reads.map(read => read.sourceId)).size !== reads.length ||
    reads.some(read => !ledger.sources.some(source => source.sourceId === read.sourceId))) invalid();
  const byId = new Map(reads.map(read => [read.sourceId, read]));
  const sources = ledger.sources.map(source => {
    const read = byId.get(source.sourceId);
    if (!read) return source;
    const readPublication = sourcePublishedAt(read.publishedAt);
    const publishedAt = readPublication ?? source.publishedAt;
    const conflict = !!source.publishedAt && !!readPublication && source.publishedAt !== readPublication;
    const warnings = unique([...source.warnings, ...read.warnings, ...(conflict ? ['source_publication_conflict'] : [])]);
    return { ...source, ...(read.status === 'read' ? { content: read.text } : {}),
      publishedAt, readAt: read.retrievedAt, readStatus: read.status,
      decision: 'candidate' as const, reason: undefined,
      dateStatus: warnings.includes('source_publication_conflict') ? 'date_unknown' : publicationDateStatus(publishedAt, scope), warnings };
  });
  return { ...ledger, sources, assessment: reads.length ? null : ledger.assessment };
}

/** Adoption follows relevance and actual supported aspects, never host/domain counting. */
export function applyAssessment(ledger: EvidenceLedger, assessment: EvidenceAssessment): EvidenceLedger {
  assertLedgerRun(ledger);
  const parsed = EvidenceAssessmentSchema.safeParse(assessment);
  if (!parsed.success) invalid();
  const result = parsed.data;
  const ids = new Set(ledger.sources.map(source => source.sourceId));
  if (result.sources.length !== ids.size || new Set(result.sources.map(source => source.sourceId)).size !== ids.size ||
    result.sources.some(source => !ids.has(source.sourceId)) ||
    result.conflicts.some(conflict => conflict.sourceIds.some(id => !ids.has(id)))) invalid();
  const byId = new Map(result.sources.map(source => [source.sourceId, source]));
  return { ...ledger, assessment: result, sources: ledger.sources.map(source => {
    const assessed = byId.get(source.sourceId)!;
    return { ...source, decision: assessed.relevant && assessed.supportedAspects.length ? 'accepted' : 'rejected', reason: assessed.reason };
  }) };
}
