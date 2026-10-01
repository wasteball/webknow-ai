import { appError } from '../errors';
import { cleanAnswer, validateArticleCitations } from '../validate';
import { AGENT_LIMITS } from './agent-limits';
import { AgentActionSchema } from './agent-schema';
import type { AgentCheckpoint, AgentOutcome, ChatReference, FinishFreshness, ResearchSummary } from './agent-types';
import { assertLedgerRun } from './evidence';
import { publicSourceUrl } from './source-url';

function invalid(): never { throw appError('BAD_OUTPUT', '回答使用了本轮未核实的来源。'); }

export function toResearchAnswer(outcome: Extract<AgentOutcome, { kind: 'finished' }>): {
  answer: string; source: 'original' | 'extended' | 'unknown'; citations: { blockId: string }[];
  references: string[]; unanswered: string[]; webReferences: ChatReference[]; research: ResearchSummary;
} {
  const { ledger, snapshot } = outcome.checkpoint;
  assertLedgerRun(ledger, snapshot.identity.runId);
  const parsed = AgentActionSchema.safeParse(outcome.answer);
  if (!parsed.success || parsed.data.type !== 'finish_answer') invalid();
  const candidate = parsed.data;
  const citations = validateArticleCitations(candidate.citations, snapshot.blocks, candidate.source);
  if (!citations.ok) throw citations.error;
  if ((candidate.source === 'original' && candidate.references.length) ||
    (candidate.source === 'extended' && !candidate.references.length)) invalid();
  const webReferences: ChatReference[] = [];
  for (const id of candidate.references) {
    const source = ledger.sources.find(item => item.sourceId === id);
    if (!source || source.decision !== 'accepted') invalid();
    const url = publicSourceUrl(source.url);
    if (!url) invalid();
    if (!webReferences.some(reference => reference.url === url.href)) webReferences.push({
      sourceId: source.sourceId, url: url.href, title: source.title, domain: url.hostname,
      publishedAt: source.publishedAt, retrievedAt: source.retrievedAt, readStatus: source.readStatus,
    });
  }
  if (webReferences.length > AGENT_LIMITS.sourceReads) invalid();
  const references = webReferences.map(reference => reference.url);
  const cleaned = cleanAnswer({ ...candidate, references }, snapshot.blocks,
    webReferences.map(reference => ({ ...reference, snippet: '' })));
  if (!cleaned.ok) throw cleaned.error;
  // Audit owns claim-scoped freshness. Historical background must not invalidate requested-time support here.
  const research = researchSummary(outcome.checkpoint, candidate.freshness, outcome.degraded);
  return { answer: cleaned.value.answer, source: candidate.source, citations: citations.value,
    references, unanswered: cleaned.value.unanswered, webReferences, research };
}

/** Explicit allowlist for panel/completed detail; excludes source content and raw audit output. */
export function researchSummary(checkpoint: AgentCheckpoint, freshness: FinishFreshness = 'not_applicable', degraded = false): ResearchSummary {
  const { ledger } = checkpoint;
  return {
    sources: ledger.sources.map(source => ({
      sourceId: source.sourceId, title: source.title, url: source.url, domain: source.domain,
      snippet: source.snippet, provider: source.provider, attempts: [...source.attempts],
      publishedAt: source.publishedAt, retrievedAt: source.retrievedAt,
      ...(source.readAt === undefined ? {} : { readAt: source.readAt }), readStatus: source.readStatus,
      decision: source.decision, ...(source.reason === undefined ? {} : { reason: source.reason }),
      dateStatus: source.dateStatus, warnings: [...source.warnings],
    })),
    attempts: ledger.attempts.map(attempt => ({
      id: attempt.id, action: { type: 'search_web', query: attempt.action.query, purpose: attempt.action.purpose,
        freshness: attempt.action.freshness, language: attempt.action.language,
        domains: [...attempt.action.domains], maxResults: attempt.action.maxResults },
      queryKey: attempt.queryKey, strategyKey: attempt.strategyKey, status: attempt.status, reason: attempt.reason,
      ...(attempt.retryOf === undefined ? {} : { retryOf: attempt.retryOf }),
      sourceIds: [...attempt.sourceIds], retrievedAt: attempt.retrievedAt,
    })),
    conflicts: (ledger.assessment?.conflicts ?? []).map(conflict => ({ sourceIds: [...conflict.sourceIds], description: conflict.description })),
    freshness, degraded,
  };
}
