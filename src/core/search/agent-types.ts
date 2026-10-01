import type { EvidenceBlock } from '../blocks';
import type { Message } from '../model-call';
import type { Quote } from '../quote';

export type Freshness = 'live' | 'day' | 'week' | 'month' | 'any';
export type NetworkMode = 'auto' | 'force' | 'article';
export type SearchPurpose = 'latest' | 'fact_check' | 'compare' | 'background' | 'article_gap';
export type AgentPhase = 'deciding' | 'searching' | 'reading' | 'checking' | 'answering' | 'waiting' | 'degraded';
export type FinishFreshness = 'verified' | 'date_unknown' | 'stale' | 'not_applicable';
export type TimeContext = {
  nowIso: string; localDate: string; timeZone: string;
  from?: string; to?: string;
};
export type GateResult = {
  level: 'required' | 'recommended' | 'not_needed' | 'ambiguous';
  canSearch: boolean; mustSearch: boolean;
  freshness: Freshness; time: TimeContext; reasons: string[];
};
export type SearchAction = {
  type: 'search_web'; query: string; purpose: SearchPurpose;
  freshness: Freshness; language: string; domains: string[]; maxResults: number;
};
export type ReadAction = { type: 'read_sources'; sourceIds: string[]; focus: string };
export type AskUserAction = {
  type: 'ask_user'; question: string;
  reason: 'ambiguous_entity' | 'permission' | 'conflict';
};
export type FinishAction = {
  type: 'finish_answer'; answer: string; source: 'original' | 'extended' | 'unknown';
  citations: string[]; references: string[]; unanswered: string[]; freshness: FinishFreshness;
};
export type AgentAction = SearchAction | ReadAction | AskUserAction | FinishAction;
export type AgentSettings = {
  enabled: boolean; freshness: 'auto' | Freshness; depth: 'quick' | 'deep';
  language: string; region: string; preferredDomains: string[];
  sourceReading: 'off' | 'provider' | 'direct_allowed';
  policy: string;
};
export type RunIdentity = {
  tabId: number; sessionId: string; runId: string;
  url: string; fingerprint: string; modelProvider: 'deepseek' | 'zhipu'; modelId: string;
};
export type SourceRecord = {
  sourceId: string; title: string; url: string; domain: string; snippet: string;
  provider: string; attempts: number[]; publishedAt: string | null; retrievedAt: string;
  readAt?: string; content?: string;
  readStatus: 'not_read' | 'read' | 'unavailable';
  decision: 'candidate' | 'accepted' | 'rejected'; reason?: string;
  dateStatus: 'fresh' | 'stale' | 'date_unknown' | 'not_applicable';
  warnings: string[];
};
export type SearchAttempt = {
  id: number; action: SearchAction; queryKey: string; strategyKey: string;
  status: 'ok' | 'empty' | 'transient' | 'failed';
  reason: string; retryOf?: number; sourceIds: string[]; retrievedAt: string;
};
export type EvidenceAssessment = {
  sources: { sourceId: string; relevant: boolean; supportedAspects: string[]; reason: string }[];
  missing: string[];
  conflicts: { sourceIds: string[]; description: string }[];
};
export type EvidenceLedger = {
  runId: string; sources: SourceRecord[]; attempts: SearchAttempt[];
  assessment: EvidenceAssessment | null;
};
export type AgentSnapshot = {
  identity: RunIdentity; question: string; quote: Quote | null;
  title: string; blocks: EvidenceBlock[]; disclosure: string;
  history: { question: string; answer: string }[];
  /** User clarification is untrusted intent, never article/external fact evidence. */
  clarifications?: { question: string; answer: string }[];
  gate: GateResult; settings: AgentSettings;
  policyVersion: string; answerPolicy: string; diagrams: boolean; thinking?: string;
};
export type AgentCheckpoint = {
  snapshot: AgentSnapshot; ledger: EvidenceLedger;
  actions: number; audits: number; formatRepairs: number;
  readIds: string[]; noGainByStrategy: Record<string, number>;
  deadlineAt: number; eventSeq: number; feedback: string[];
  waiting: AskUserAction | null;
};
export type AgentEvent = {
  identity: RunIdentity; seq: number; phase: AgentPhase;
  searches: number; reads: number;
  reason: 'initial' | 'retry' | 'conflict' | 'insufficient' | 'complete' | 'timeout';
};
export type AuditResult = {
  decision: 'accept' | 'revise' | 'research';
  claims: { text: string; sourceIds: string[]; temporalScope?: 'requested' | 'background' }[];
  missing: string[]; conflicts: string[]; freshness: FinishFreshness;
};
export type AgentJsonCall = (
  messages: Message[], signal: AbortSignal
) => Promise<unknown>;
export type SearchBatch = {
  status: 'ok' | 'empty' | 'transient' | 'failed';
  results: { title: string; url: string; snippet: string; publishedAt?: string | null }[];
  provider: string; retrievedAt: string; warnings: string[];
};
export type SourceRead = {
  sourceId: string; text: string; publishedAt: string | null; retrievedAt: string;
  status: 'read' | 'unavailable'; warnings: string[];
};
export type AgentDependencies = {
  callJson: AgentJsonCall;
  search: (action: SearchAction, signal: AbortSignal) => Promise<SearchBatch>;
  read: (ids: string[], focus: string, ledger: EvidenceLedger, signal: AbortSignal) => Promise<SourceRead[]>;
  assertCurrent: () => Promise<void>;
  now: () => number;
  onEvent: (event: AgentEvent) => void;
};
export type AgentOutcome =
  | { kind: 'finished'; checkpoint: AgentCheckpoint; answer: FinishAction; degraded: boolean }
  | { kind: 'waiting'; checkpoint: AgentCheckpoint; question: AskUserAction };
export type AgentResume = { mode: 'continue' | 'article'; text: string };
