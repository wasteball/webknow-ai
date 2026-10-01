import type { AgentCheckpoint, AgentSnapshot } from './agent-types';

export const AGENT_LIMITS = Object.freeze({
  searches: 5, sourceReads: 5, sourceChars: 12_000, totalSourceChars: 40_000,
  actions: 12, audits: 3, formatRepairs: 1,
  timeoutMs: 180_000, hardTimeoutMs: 300_000,
});

export function initialCheckpoint(snapshot: AgentSnapshot, nowMs: number): AgentCheckpoint {
  return {
    snapshot,
    ledger: { runId: snapshot.identity.runId, sources: [], attempts: [], assessment: null },
    actions: 0, audits: 0, formatRepairs: 0,
    readIds: [], noGainByStrategy: {},
    deadlineAt: nowMs + AGENT_LIMITS.timeoutMs, eventSeq: 0, feedback: [], waiting: null,
  };
}
