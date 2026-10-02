import { appError, isAppError } from '../errors';
import { LIMITS } from '../limits';
import { agentMessages } from '../prompts/search-agent';
import { validateArticleCitations } from '../validate';
import { requestAction } from './action-call';
import { AGENT_LIMITS } from './agent-limits';
import type { AgentCheckpoint, AgentDependencies, AgentEvent, AgentJsonCall, AgentOutcome, AgentResume, EvidenceLedger, SearchAction, SearchBatch } from './agent-types';
import { researchSummary } from './answer';
import { assessEvidence, auditAnswer } from './auditor';
import { applyAssessment, assertLedgerRun, recordReads, recordSearch } from './evidence';
import { queryChange, queryKey, strategyKey } from './query';

const SEARCH_TIMEOUT = Symbol('search phase timeout');
const ARTICLE_ONLY = 'article_only_resume';
const unique = (values: string[]) => [...new Set(values)];
const badCheckpoint = () => appError('BAD_OUTPUT', '研究检查点无效，请重新开始。');

/** No model-generated draft is adopted on any timeout or exhausted control path. */
function deadlineFallback(checkpoint: AgentCheckpoint): AgentOutcome {
  return { kind: 'finished', degraded: true,
    checkpoint: { ...checkpoint, ledger: { ...checkpoint.ledger, sources: checkpoint.ledger.sources.map(({ content: _content, ...source }) => source) } },
    answer: { type: 'finish_answer', answer: '这次没有核验成功', source: 'unknown', citations: [], references: [],
      unanswered: unique([...(checkpoint.ledger.assessment?.missing ?? []), ...checkpoint.feedback,
        ...(checkpoint.waiting ? [checkpoint.waiting.question] : [])]).slice(-20).map(text => text.slice(0, LIMITS.maxQuestionChars)),
      freshness: 'not_applicable' } };
}

/** Improvement is per supported aspect, not per URL or host. */
function support(ledger: EvidenceLedger): Map<string, { date: string; read: boolean }> {
  const result = new Map<string, { date: string; read: boolean }>();
  for (const assessed of ledger.assessment?.sources ?? []) {
    const source = ledger.sources.find(item => item.sourceId === assessed.sourceId);
    if (!source || source.decision !== 'accepted' || !assessed.relevant) continue;
    for (const value of assessed.supportedAspects) {
      const aspect = value.normalize('NFKC').trim().toLowerCase();
      const previous = result.get(aspect);
      const date = source.dateStatus === 'fresh' || source.dateStatus === 'not_applicable' ? source.publishedAt ?? '' : '';
      result.set(aspect, { date: date > (previous?.date ?? '') ? date : previous?.date ?? '',
        read: !!previous?.read || (source.readStatus === 'read' && !!source.content?.trim()) });
    }
  }
  return result;
}

function hasGain(before: ReturnType<typeof support>, after: ReturnType<typeof support>): boolean {
  return [...after].some(([aspect, value]) => {
    const old = before.get(aspect);
    return !old || value.date > old.date || (value.read && !old.read);
  });
}

/** Deliberately excludes query tokens. Lexical repeat detection is a separate check. */
function familyKey(checkpoint: AgentCheckpoint, action: SearchAction): string {
  const previous = checkpoint.ledger.attempts.at(-1);
  const failure = !previous ? 'initial' : previous.status !== 'ok' ? previous.status
    : checkpoint.ledger.assessment?.conflicts.length ? 'conflict'
      : checkpoint.ledger.sources.some(source => source.decision === 'accepted' && source.dateStatus === 'stale') ? 'stale'
        : checkpoint.ledger.sources.some(source => source.decision === 'accepted' && source.dateStatus === 'date_unknown') ? 'date_unknown'
          : 'insufficient';
  return JSON.stringify([failure, action.purpose, previous ? queryChange(previous.action, action).dimensions : []]);
}

export async function runResearch(input: {
  checkpoint: AgentCheckpoint; deps: AgentDependencies; signal: AbortSignal; resume?: AgentResume;
}): Promise<AgentOutcome> {
  const { deps, signal } = input;
  assertLedgerRun(input.checkpoint.ledger, input.checkpoint.snapshot.identity.runId);
  const checkpoint = structuredClone(input.checkpoint);
  const quick = checkpoint.snapshot.settings.depth === 'quick';
  const limits = { searches: quick ? 3 : AGENT_LIMITS.searches, reads: quick ? 2 : AGENT_LIMITS.sourceReads,
    actions: quick ? 8 : AGENT_LIMITS.actions, audits: quick ? 2 : AGENT_LIMITS.audits };
  const startedAt = Date.parse(checkpoint.snapshot.gate.time.nowIso);
  if (!Number.isFinite(startedAt) || !Number.isFinite(checkpoint.deadlineAt) ||
    [checkpoint.actions, checkpoint.audits, checkpoint.formatRepairs, checkpoint.eventSeq].some(value => !Number.isSafeInteger(value) || value < 0) ||
    checkpoint.formatRepairs > AGENT_LIMITS.formatRepairs) throw badCheckpoint();
  checkpoint.deadlineAt = Math.min(checkpoint.deadlineAt,
    startedAt + (quick ? 90_000 : AGENT_LIMITS.timeoutMs), startedAt + AGENT_LIMITS.hardTimeoutMs);

  function active(): void {
    if (signal.aborted) throw appError('ABORTED', '已经停止。');
    if (deps.now() >= checkpoint.deadlineAt) throw appError('TIMEOUT', '研究等待时间已到。');
  }

  // Race even dependencies that ignore AbortSignal; abandoned results cannot reach ledger/events.
  async function bounded<T>(operation: (child: AbortSignal) => Promise<T>, timeoutMs: number, recoverSearchTimeout = false): Promise<T> {
    active();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => { controller.abort(); reject(appError('ABORTED', '已经停止。')); };
      signal.addEventListener('abort', onAbort, { once: true });
      // Settle our cause first: abort-aware transports may synchronously reject from their listener.
      const remaining = checkpoint.deadlineAt - deps.now();
      timer = setTimeout(() => {
        reject(recoverSearchTimeout && timeoutMs < remaining ? SEARCH_TIMEOUT : appError('TIMEOUT', '研究等待时间已到。'));
        controller.abort();
      }, Math.min(timeoutMs, remaining));
    });
    try {
      active();
      const value = await Promise.race([operation(controller.signal), cancelled]);
      active();
      return value;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function guard(): Promise<void> {
    active();
    await bounded(() => deps.assertCurrent(), LIMITS.requestTimeoutMs);
    active();
    assertLedgerRun(checkpoint.ledger, checkpoint.snapshot.identity.runId);
  }
  async function call<T>(operation: (child: AbortSignal) => Promise<T>, timeout: number = LIMITS.requestTimeoutMs, recoverSearchTimeout = false): Promise<T> {
    await guard();
    let result: T;
    try {
      result = await bounded(operation, timeout, recoverSearchTimeout);
    } catch (error) {
      // Expiry/stop must never initiate another dependency. Other failures still need identity validation.
      if (!(isAppError(error) && (error.code === 'TIMEOUT' || error.code === 'ABORTED'))) await guard();
      throw error;
    }
    await guard();
    return result;
  }
  const callJson: AgentJsonCall = (messages) => call(child => deps.callJson(messages, child));
  function emit(phase: AgentEvent['phase'], reason: AgentEvent['reason']): void {
    active();
    deps.onEvent({ identity: { ...checkpoint.snapshot.identity }, seq: ++checkpoint.eventSeq, phase,
      searches: checkpoint.ledger.attempts.length, reads: checkpoint.readIds.length, reason, details: researchSummary(checkpoint) });
    active();
  }
  function feedback(text: string): void {
    checkpoint.feedback = unique([...checkpoint.feedback, text]).slice(-20);
  }
  async function assess(before: ReturnType<typeof support>, family?: string): Promise<void> {
    emit('checking', 'insufficient');
    const assessment = await assessEvidence({ snapshot: checkpoint.snapshot, ledger: checkpoint.ledger, callJson, signal });
    await guard();
    checkpoint.ledger = applyAssessment(checkpoint.ledger, assessment);
    if (family) checkpoint.noGainByStrategy[family] = hasGain(before, support(checkpoint.ledger))
      ? 0 : (checkpoint.noGainByStrategy[family] ?? 0) + 1;
  }

  try {
    await guard();
    if (input.resume) {
      if (!checkpoint.waiting || !input.resume.text.trim()) throw badCheckpoint();
      checkpoint.snapshot.clarifications = [...(checkpoint.snapshot.clarifications ?? []), {
        question: checkpoint.waiting.question.slice(0, LIMITS.maxQuestionChars),
        answer: input.resume.text.slice(0, LIMITS.maxLearningAnswerChars),
      }].slice(-AGENT_LIMITS.actions);
      checkpoint.waiting = null;
      if (input.resume.mode === 'article') {
        checkpoint.snapshot.gate = { ...checkpoint.snapshot.gate, canSearch: false, mustSearch: false,
          reasons: unique([...checkpoint.snapshot.gate.reasons, ARTICLE_ONLY]) };
        checkpoint.ledger = { ...checkpoint.ledger, sources: [], assessment: null,
          attempts: checkpoint.ledger.attempts.map(attempt => ({ ...attempt, sourceIds: [] })) };
        feedback('仅依据当前文章回答；未联网核验。');
      }
    } else if (checkpoint.waiting) {
      return { kind: 'waiting', checkpoint, question: checkpoint.waiting };
    }

    while (checkpoint.actions < limits.actions && checkpoint.audits < limits.audits) {
      await guard();
      emit('deciding', checkpoint.actions ? 'insufficient' : 'initial');
      checkpoint.actions++;
      let actionCalls = 0;
      const result = await requestAction({ messages: agentMessages(checkpoint), signal,
        repairAllowed: checkpoint.formatRepairs < AGENT_LIMITS.formatRepairs,
        callJson: (messages, s) => {
          if (actionCalls++ > 0) checkpoint.formatRepairs++;
          return callJson(messages, s);
        } });
      await guard();
      const action = result.action;
      if (action.type === 'ask_user') {
        checkpoint.waiting = action;
        emit('waiting', action.reason === 'conflict' ? 'conflict' : 'insufficient');
        return { kind: 'waiting', checkpoint, question: action };
      }
      if (action.type === 'search_web') {
        if (!checkpoint.snapshot.settings.enabled || !checkpoint.snapshot.gate.canSearch || checkpoint.ledger.attempts.length >= limits.searches) {
          feedback('当前不能继续搜索；请依据允许的证据回答或明确说明缺口。'); continue;
        }
        const previous = checkpoint.ledger.attempts.at(-1);
        const retryOf = previous?.status === 'transient' && previous.retryOf === undefined &&
          previous.queryKey === queryKey(action) && previous.action.maxResults === action.maxResults ? previous.id : undefined;
        const family = familyKey(checkpoint, action);
        if ((checkpoint.noGainByStrategy[family] ?? 0) >= 2 || (retryOf === undefined &&
          checkpoint.ledger.attempts.some(attempt => strategyKey(attempt.action) === strategyKey(action)))) {
          feedback('当前检索策略没有新增支持或重复查询；请改变有效策略、读取来源或说明缺口。'); continue;
        }
        const before = support(checkpoint.ledger);
        const priorLedger = checkpoint.ledger;
        let batch: SearchBatch;
        try {
          batch = await call(child => {
            // Reserve immediately before transmission, retaining the attempted query on timeout.
            checkpoint.ledger = recordSearch(priorLedger, action, { status: 'failed', results: [], provider: '',
              retrievedAt: new Date(deps.now()).toISOString(), warnings: [] }, '搜索未完成，未采用返回内容。', retryOf, checkpoint.snapshot.gate);
            checkpoint.ledger.attempts.at(-1)!.strategyKey = family;
            checkpoint.ledger.attempts.at(-1)!.status = 'pending';
            emit('searching', retryOf ? 'retry' : 'initial');
            return deps.search(action, child);
          }, LIMITS.searchTimeoutMs, true);
        } catch (error) {
          if (error !== SEARCH_TIMEOUT) {
            const attempt = checkpoint.ledger.attempts.at(-1);
            if (attempt?.status === 'pending') attempt.status = 'failed';
            throw error;
          }
          // call() revalidates identity after phase expiry; stop/deadline still take precedence.
          active();
          batch = { status: 'transient', results: [], provider: checkpoint.snapshot.searchProviderId ?? '',
            retrievedAt: new Date(deps.now()).toISOString(), warnings: ['search_timeout'] };
        }
        checkpoint.ledger = recordSearch(priorLedger, action, batch, '受控搜索', retryOf, checkpoint.snapshot.gate);
        checkpoint.ledger.attempts.at(-1)!.strategyKey = family;
        await assess(before, family);
        continue;
      }
      if (action.type === 'read_sources') {
        const ids = unique(action.sourceIds);
        if (!checkpoint.snapshot.settings.enabled || !checkpoint.snapshot.gate.canSearch || checkpoint.snapshot.settings.sourceReading === 'off' ||
          ids.some(id => !checkpoint.ledger.sources.some(source => source.sourceId === id) || checkpoint.readIds.includes(id)) ||
          checkpoint.readIds.length + ids.length > limits.reads) {
          feedback('当前不能读取这些来源；只能读取本轮尚未读取且允许的来源。'); continue;
        }
        let remaining = AGENT_LIMITS.totalSourceChars - checkpoint.ledger.sources.reduce((sum, source) => sum + (source.content?.length ?? 0), 0);
        if (remaining <= 0) { feedback('来源正文读取已达上限，请依据已有证据回答。'); continue; }
        const before = support(checkpoint.ledger);
        const reads = await call(child => {
          checkpoint.readIds = unique([...checkpoint.readIds, ...ids]);
          emit('reading', 'insufficient');
          return deps.read([...ids], action.focus, structuredClone(checkpoint.ledger), child);
        });
        if (reads.some(read => !ids.includes(read.sourceId))) throw badCheckpoint();
        const boundedReads = reads.map(read => {
          const text = read.text.slice(0, Math.min(remaining, AGENT_LIMITS.sourceChars));
          remaining -= text.length;
          return { ...read, text, warnings: unique([...read.warnings, ...(text.length < read.text.length ? ['source_truncated'] : [])]) };
        });
        checkpoint.ledger = recordReads(checkpoint.ledger, boundedReads, checkpoint.snapshot.gate);
        await assess(before, checkpoint.ledger.attempts.at(-1)?.strategyKey);
        continue;
      }

      const articleOnly = checkpoint.snapshot.gate.reasons.includes(ARTICLE_ONLY);
      if (action.references.some(id => !checkpoint.ledger.sources.some(source => source.sourceId === id))) throw badCheckpoint();
      if (action.references.some(id => checkpoint.ledger.sources.find(source => source.sourceId === id)!.decision !== 'accepted') ||
        (action.source === 'extended' && action.references.length === 0) ||
        (checkpoint.snapshot.gate.mustSearch && action.freshness === 'verified' && !checkpoint.ledger.attempts.some(attempt => attempt.status === 'ok')) ||
        (articleOnly && (action.source === 'extended' || action.references.length > 0))) {
        feedback('回答缺少已采用的有效来源或必要搜索；请补齐证据或明确降级。'); continue;
      }
      const citations = validateArticleCitations(action.citations, checkpoint.snapshot.blocks, action.source);
      if (!citations.ok) { feedback('文章引文必须由当前文章正文支持。'); continue; }
      const disclosure = '\n\n仅依据当前文章，未联网核验。';
      const candidate = articleOnly ? { ...action, answer: `${action.answer.slice(0, 8000 - disclosure.length)}${disclosure}`,
        freshness: 'not_applicable' as const, unanswered: unique(['未联网核验。', ...action.unanswered]).slice(0, 20) } : action;
      emit('answering', 'insufficient');
      checkpoint.audits++;
      const audit = await auditAnswer({ candidate, snapshot: checkpoint.snapshot, ledger: checkpoint.ledger, callJson, signal });
      await guard();
      if (audit.decision === 'accept') {
        emit('answering', 'complete');
        return { kind: 'finished', checkpoint, answer: candidate,
          degraded: articleOnly || candidate.source === 'unknown' || candidate.unanswered.length > 0 ||
            candidate.freshness === 'date_unknown' || candidate.freshness === 'stale' };
      }
      feedback(audit.decision === 'research' ? '独立审查要求补齐证据。' : '独立审查要求修订回答。');
      for (const gap of [...audit.missing, ...audit.conflicts]) feedback(gap);
    }
    feedback('本轮研究已达到可靠性上限，仍有信息未核验。');
    emit('degraded', 'insufficient');
    return deadlineFallback(checkpoint);
  } catch (error) {
    if (signal.aborted) throw appError('ABORTED', '已经停止。');
    if (isAppError(error) && (error.code === 'TIMEOUT' || error.code === 'BAD_OUTPUT')) {
      feedback(error.code === 'TIMEOUT' ? '本轮等待时间已到，请显式开始新一轮研究。' : '本轮输出未通过固定契约检查。');
      return deadlineFallback(checkpoint);
    }
    throw error;
  }
}
