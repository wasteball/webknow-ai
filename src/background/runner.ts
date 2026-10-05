import { buildContext, describeCompleteness } from '../core/blocks';
import { appError, isAppError, type AppError } from '../core/errors';
import { LIMITS } from '../core/limits';
import { ANSWER_DEFAULT_POLICY, answerMessages } from '../core/prompts/answer';
import { guideMessages, summaryCharsFor } from '../core/prompts/guide';
import {
  DEFAULT_LEARN_GOAL,
  archiveLearning,
  freezeLearnPolicy,
  frozenLearnCall,
  rememberLearnGoal,
  unknownAssistMode,
} from '../core/learn-policy';
import { learnMessages, type LearnMode } from '../core/prompts/learn';
import type { AgentCheckpoint, AgentEvent, AgentResume, NetworkMode, RunIdentity } from '../core/search/agent-types';
import { runtimeAgentSettings } from '../core/search/agent-policy';
import { initialCheckpoint } from '../core/search/agent-limits';
import { evaluateSearchGate } from '../core/search/gate';
import { SEARCH_AGENT_VERSION } from '../core/prompts/search-agent';
import { toResearchAnswer } from '../core/search/answer';
import { assertResearchCurrent, executeResearch, permissionOrigins, researchModelSelection } from './research';
import { hasAskedQuestion, newTopicId, startsNewTopic, topicHistory } from '../core/topic';
import { prepareQuote, type Quote } from '../core/quote';
import { browser } from 'wxt/browser';
import { outboundScope, effectiveSettings } from '../core/settings';
import { resolvePolicy } from '../core/skills';
import {
  acceptsWriteBack,
  appendLearn,
  attachCallReasoning,
  beginRun,
  canStartLearning,
  endRun,
  markStale,
  newId,
  nextQuestionAllowed,
  stateAfterFailure,
  stateAfterStop,
  type LearnSupplement,
  type LearningState,
  type MasteryLabel,
  type PageSession,
  type QuestionTarget,
  type RequestKind,
} from '../core/session';
import {
  classifyPageDrift,
  planWriteBack,
  sessionWithNewExtract,
  writeBackError,
} from '../core/page-drift';
import { presentReasoning } from '../core/stream-draft';
import { cleanAnswer, cleanGuide, cleanLearn, omitBlockIds, type LearnResult } from '../core/validate';
import { applyImageReadings } from '../core/vision';
import { assertOutboundConfirmation, callModel, currentProvider, readImage } from './model';
import { captureImage, extractPage, readPageIdentity, toAppError } from './page';
import { getSession, putSession, readApiKey, readConfig } from './store';

/**
 * 请求流水线（三类请求共用一条）：
 *   守卫 → 组装上下文 → 提示词策略 → 模型调用 → 结构校验 → 引用校验 → 写回守卫 → 持久化
 * 新增能力只需要新增策略文件与校验器，不需要改这条流水线（FR-026/FR-029）。
 */

export type Intent =
  | { kind: 'guide'; tabId: number }
  | { kind: 'ask'; tabId: number; question: string; search?: boolean; quote?: string | null; quoteId?: string }
  | { kind: 'resolveResearch'; tabId: number; sessionId: string; runId: string; mode: 'continue' | 'article' | 'cancel'; text: string }
  | { kind: 'learnStart'; tabId: number; goal: string; search?: boolean }
  | { kind: 'learnAnswer'; tabId: number; text: string; choices?: LearnChoiceAnswer[]; search?: boolean }
  | { kind: 'learnAssist'; tabId: number; assist: 'hint' | 'explain' | 'skip' | 'unknown'; search?: boolean }
  | { kind: 'learnEnd'; tabId: number };

/** 选择题作答：一题多个选项 id。 */
export type LearnChoiceAnswer = { questionId: string; choiceIds: string[] };

export type RunnerHooks = {
  onAgent?: (tabId: number, event: AgentEvent) => void;
  onState: (tabId: number) => void | Promise<void>;
  onProgress: (tabId: number, chars: number, draft: string, reasoning: string) => void;
};

type Task = (
  session: PageSession,
  runId: string,
  signal: AbortSignal,
) => Promise<PageSession | null>;

/** 每个标签页同时只允许一个在途请求（FR-039）。 */
type ActiveRun = { runId: string; sessionId: string; controller: AbortController; research?: boolean; waiting?: boolean; seq?: number; agent?: AgentEvent };
const controllers = new Map<number, ActiveRun>();
export function currentAgentEvent(tabId: number): AgentEvent | undefined { return controllers.get(tabId)?.agent; }

/** Storage is evidence, not authorization: only this worker's live run grants permission. */
export function assertActiveResearch(identity: RunIdentity, session: PageSession | null): AgentCheckpoint['snapshot'] {
  const active = controllers.get(identity.tabId);
  const snapshot = session?.researchCheckpoint?.snapshot;
  if (!active?.research || active.controller.signal.aborted || active.sessionId !== identity.sessionId || active.runId !== identity.runId ||
      session?.id !== identity.sessionId || session.run?.id !== identity.runId || session.url !== identity.url || session.fingerprint !== identity.fingerprint || !snapshot?.settings.enabled ||
      Object.entries(identity).some(([key, value]) => snapshot.identity[key as keyof RunIdentity] !== value)) {
    throw appError('ABORTED', '这次研究的联网许可已失效，请重新提问。');
  }
  return snapshot;
}
const recoveries = new Map<number, Promise<PageSession | null>>();

/** A restarted worker cannot resume a persisted network request. Keep history and permit retry. */
export function recoverInterruptedRun(tabId: number): Promise<PageSession | null> {
  const pending = recoveries.get(tabId);
  if (pending) return pending;
  const recovery = (async () => {
    const session = await getSession(tabId);
    const active = controllers.get(tabId);
    if (!session?.run) return session;
    const registered = active?.sessionId === session.id && active.runId === session.run.id;
    const expired = registered && active.waiting && (session.researchCheckpoint?.deadlineAt ?? Infinity) <= Date.now();
    if (registered && !(active.research && active.waiting && (active.controller.signal.aborted || expired))) return session;
    const stopped = registered && active.controller.signal.aborted;
    if (registered && active.waiting) controllers.delete(tabId);
    const next = {
      ...endRun(session, session.run.id),
      researchCheckpoint: undefined,
      researchPending: session.researchPending ? { ...session.researchPending, status: stopped ? 'stopped' as const : 'interrupted' as const } : undefined,
      state: stopped ? stateAfterStop(session, session.run.kind) : stateAfterFailure(session, session.run.kind),
      error: stopped ? null : appError('INTERNAL', '刚才的生成被中断了。已有对话还在，请重试刚才的操作。', true),
    };
    await putSession(next);
    return next;
  })();
  recoveries.set(tabId, recovery);
  void recovery.finally(() => recoveries.delete(tabId)).catch(() => {});
  return recovery;
}

export function abortRun(tabId: number): boolean {
  const active = controllers.get(tabId);
  if (!active) return false;
  active.controller.abort();
  return true;
}

/** 更换接收方时终止所有仍在执行的正文请求。 */
export function abortAllRuns(): void {
  for (const tabId of [...controllers.keys()]) abortRun(tabId);
}

export async function handleIntent(intent: Intent, hooks: RunnerHooks): Promise<AppError | null> {
  switch (intent.kind) {
    case 'guide':
      return runGuide(intent.tabId, hooks);
    case 'ask':
      return runAsk(intent.tabId, intent.question, intent.search === true ? 'auto' : 'article', hooks, intent.quote, intent.quoteId);
    case 'resolveResearch':
      return resolveResearch(intent, hooks);
    case 'learnStart':
      return runLearnStart(intent.tabId, intent.goal, intent.search === true, hooks);
    case 'learnAnswer':
      return runLearnStep(intent.tabId, 'respond', { userAnswer: intent.text, userChoices: intent.choices, search: intent.search === true }, hooks);
    case 'learnAssist':
      return runAssist(intent.tabId, intent.assist, intent.search === true, hooks);
    case 'learnEnd':
      return runLearnStep(intent.tabId, 'close', {}, hooks);
  }
}

/** Status hints are best-effort; research readiness explicitly awaits onState below. */
function notifyState(hooks: RunnerHooks, tabId: number): void {
  void Promise.resolve(hooks.onState(tabId)).catch(() => {});
}

async function withRun(
  tabId: number,
  kind: RequestKind,
  task: Task,
  hooks: RunnerHooks,
): Promise<AppError | null> {
  try {
    assertOutboundConfirmation(await readConfig());
  } catch (error) {
    return toAppError(error);
  }
  const session = await recoverInterruptedRun(tabId);
  if (!session) {
    return appError('STALE_PAGE', '当前标签页没有可用的页面会话。请重新开始伴读。', true);
  }
  const active = controllers.get(tabId);
  if (active?.sessionId === session.id) return appError('BUSY', '上一步还在进行中。先点停止，再做别的。', true);
  active?.controller.abort();
  const begun = beginRun(session, kind);
  if (!begun.ok) {
    await putSession({ ...session, error: begun.error, updatedAt: Date.now() });
    notifyState(hooks, tabId);
    return begun.error;
  }

  const controller = new AbortController();
  controllers.set(tabId, { runId: begun.run.id, sessionId: session.id, controller });
  await putSession(begun.session);
  // 用户触发后立即进入等待态（NFR-001），不等第一个字节。
  notifyState(hooks, tabId);

  return invokeRun(tabId, kind, begun.session, begun.run.id, controller, task, hooks);
}

async function invokeRun(tabId: number, kind: RequestKind, session: PageSession, runId: string,
  controller: AbortController, task: Task, hooks: RunnerHooks): Promise<AppError | null> {
  let failure: AppError | null = null;
  try {
    const next = await task(session, runId, controller.signal);
    if (next) await putSession(next);
  } catch (error) {
    failure = toAppError(error);
    const fresh = await getSession(tabId);
    if (fresh && acceptsWriteBack(fresh, runId)) {
      const stopped = failure.code === 'ABORTED';
      await putSession({
        ...endRun(fresh, runId),
        researchCheckpoint: undefined,
        researchPending: fresh.researchPending ? { ...fresh.researchPending, status: stopped ? 'stopped' : 'interrupted' } : undefined,
        state: stopped ? stateAfterStop(fresh, kind) : stateAfterFailure(fresh, kind),
        error: stopped ? null : failure,
        updatedAt: Date.now(),
      });
    }
  } finally {
    const fresh = await getSession(tabId);
    const active = controllers.get(tabId);
    const waiting = active?.controller === controller && active.waiting && !controller.signal.aborted && fresh?.run?.id === runId;
    if (!waiting && fresh?.run?.id === runId) await putSession(endRun(fresh, runId));
    if (!waiting && active?.controller === controller) controllers.delete(tabId);
    notifyState(hooks, tabId);
  }
  return failure;
}

/**
 * 用户发出去之后，若仍是这一页、只是正文改过，先换成新正文再问。
 * 已经说过的话留着。地址已经换了就停在这里，并告诉用户。
 */
async function adoptCurrentPage(tabId: number, session: PageSession): Promise<PageSession> {
  const live = await readPageIdentity(tabId);
  const drift = classifyPageDrift(session, live);
  if (drift === 'replaced' && live) {
    if (session.run) await dropReplaced(tabId, session.run.id, live.url);
    throw writeBackError(planWriteBack(drift, live));
  }
  if (drift === 'same' && live && live.url !== session.url) {
    const current = { ...session, url: live.url, updatedAt: Date.now() };
    await putSession(current);
    return current;
  }
  if (drift !== 'edited') return session;
  const page = await extractPage(tabId);
  const next = sessionWithNewExtract(session, page);
  if (next === 'replaced') {
    if (session.run) await dropReplaced(tabId, session.run.id, page.url);
    throw writeBackError({ action: 'replaced', url: page.url });
  }
  await putSession(next);
  return next;
}

async function dropReplaced(tabId: number, runId: string, url: string): Promise<void> {
  const fresh = await getSession(tabId);
  if (fresh && acceptsWriteBack(fresh, runId)) await putSession(markStale(fresh, url));
}

/**
 * 写回守卫：请求身份必须还是这一次。
 * 同一地址上正文改过，结果仍写上（它对应发出去时读到的正文）。
 * 地址变了就标成换页并说明；对不上页面时说明原因，不清掉已有对话。
 */
async function writeBack(
  tabId: number,
  session: PageSession,
  runId: string,
  mutate: (fresh: PageSession) => PageSession,
): Promise<PageSession | null> {
  const live = await readPageIdentity(tabId);
  const plan = planWriteBack(classifyPageDrift(session, live), live);
  const error = writeBackError(plan);
  if (error) {
    if (plan.action === 'replaced') await dropReplaced(tabId, runId, plan.url);
    throw error;
  }
  const fresh = await getSession(tabId);
  if (!fresh || !acceptsWriteBack(fresh, runId)) return null;
  return mutate(fresh);
}

function watchProgress(hooks: RunnerHooks, tabId: number, blockIds: readonly string[]) {
  let reasoning = '';
  return {
    onProgress(chars: number, draft: string, thought = '') {
      reasoning = presentReasoning(thought, blockIds);
      hooks.onProgress(tabId, chars, draft ? omitBlockIds(draft, blockIds) : '', reasoning);
    },
    reasoning() {
      return reasoning;
    },
  };
}

function contextOf(session: PageSession) {
  const ctx = buildContext(session.blocks);
  if (!ctx.ok) throw ctx.error;
  return ctx;
}

/** 摘要、追问、学习都先读图。单张失败只记为没读，不让整次伴读失败。 */
async function attachImages(
  tabId: number,
  session: PageSession,
  signal: AbortSignal,
  hooks: RunnerHooks,
): Promise<PageSession> {
  if (session.imagesAttached || !session.pictures?.length) return session;
  const provider = await currentProvider();
  if (provider.id === 'deepseek' && !(await readApiKey(provider.id))) return session;

  hooks.onProgress(tabId, 0, '正在读这一页的图片', '');
  const readings: { id: string; text: string }[] = [];
  if (provider.id === 'deepseek') {
    const pictures = session.pictures;
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        if (signal.aborted) throw appError('ABORTED', '已经按你的要求停下来了。');
        const index = cursor;
        cursor += 1;
        if (index >= pictures.length) return;
        const picture = pictures[index];
        if (!picture) return;
        try {
          const data = await captureImage(tabId, picture.url);
          const text = await readImage(data || picture.url, signal);
          readings.push({ id: picture.id, text });
        } catch (error) {
          if (isAppError(error) && error.code === 'ABORTED') throw error;
          if (signal.aborted) throw appError('ABORTED', '已经按你的要求停下来了。');
          readings.push({ id: picture.id, text: '' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, pictures.length) }, () => worker()));
  }

  const applied = applyImageReadings(session.blocks, session.pictures, readings, session.completeness);
  const warnings = [...applied.completeness.warnings];
  if (provider.id !== 'deepseek') warnings.push('当前这家读不了图。');
  else if (applied.completeness.images.captured < applied.completeness.images.found) {
    warnings.push('有的图片没读到。');
  }
  const next: PageSession = {
    ...session,
    blocks: applied.blocks,
    completeness: { ...applied.completeness, warnings },
    imagesAttached: true,
    updatedAt: Date.now(),
  };
  await putSession(next);
  return next;
}

async function runGuide(tabId: number, hooks: RunnerHooks): Promise<AppError | null> {
  const config = await readConfig();
  const settings = effectiveSettings(config);
  return withRun(
    tabId,
    'guide',
    async (session, runId, signal) => {
      const current = await attachImages(tabId, await adoptCurrentPage(tabId, session), signal, hooks);
      const ctx = contextOf(current);
      const watch = watchProgress(
        hooks,
        tabId,
        current.blocks.map((block) => block.id),
      );
      const parsed = await callModel(
        guideMessages({
          title: current.title,
          url: current.url,
          contextJson: ctx.json,
          disclosure: describeCompleteness(current.completeness),
          override: resolvePolicy('guide', config),
          maxBubbles: settings.maxBubbles,
          summaryMaxChars: summaryCharsFor(settings.summaryLength),
        }),
        signal,
        watch.onProgress,
      );
      const clean = cleanGuide(
        parsed,
        settings.maxBubbles,
        current.blocks.map((block) => block.id),
      );
      if (!clean.ok) throw clean.error;
      const reasoning = watch.reasoning();
      return writeBack(tabId, current, runId, (fresh) => ({
        ...fresh,
        guide: reasoning ? { ...clean.value, reasoning } : clean.value,
        state: 'READY',
        error: null,
        updatedAt: Date.now(),
      }));
    },
    hooks,
  );
}

async function runAsk(
  tabId: number,
  rawQuestion: string,
  network: NetworkMode,
  hooks: RunnerHooks,
  rawQuote?: string | null,
  quoteId?: string,
): Promise<AppError | null> {
  const question = rawQuestion.trim().slice(0, LIMITS.maxQuestionChars);
  if (!question) return appError('INTERNAL', '问题为空，未发送任何请求。');

  const config = await readConfig();
  return withRun(
    tabId,
    'answer',
    async (session, runId, signal) => {
      let current = await adoptCurrentPage(tabId, session);
      const topicSwitched = startsNewTopic(question);
      const legacyTopic = !current.activeTopicId;
      const topicId = topicSwitched ? newTopicId() : current.activeTopicId ?? 'legacy';
      const topicTurns = topicHistory(current.chat, topicId, legacyTopic && topicId === 'legacy');
      const settings = { ...runtimeAgentSettings(config, browser.i18n?.getUILanguage() ?? globalThis.navigator?.language ?? 'en'), enabled: network === 'auto' };
      const preparedQuote = rawQuote === undefined ? current.quote ?? null
        : rawQuote === null ? null : prepareQuote(rawQuote, current.blocks);
      const frozenQuote = preparedQuote ? { ...preparedQuote, id: rawQuote === undefined ? preparedQuote.id : quoteId ?? preparedQuote.id } : null;
      const gate = evaluateSearchGate({ question, pageTitle: current.title, quote: frozenQuote?.text ?? null,
        mode: network, enabled: settings.enabled, freshness: settings.freshness, now: new Date(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (gate.canSearch) {
        const model = researchModelSelection(config);
        const checkpoint = initialCheckpoint({
          identity: { tabId, sessionId: current.id, runId, url: current.url, fingerprint: current.fingerprint,
            modelProvider: model.modelProvider, modelId: model.modelId }, thinking: model.thinking,
          searchProviderId: config.search?.providerId, outboundScope: outboundScope(config), question, title: current.title, blocks: structuredClone(current.blocks), quote: frozenQuote,
          history: topicTurns.slice(-LIMITS.maxHistoryTurns).map(turn => ({ question: turn.question, answer: turn.answer })),
          topicId,
          disclosure: describeCompleteness(current.completeness), gate, settings,
          policyVersion: SEARCH_AGENT_VERSION, answerPolicy: resolvePolicy('answer', config) ?? ANSWER_DEFAULT_POLICY,
          diagrams: effectiveSettings(config).diagrams === 'auto',
        }, Date.now());
        const active = controllers.get(tabId)!;
        active.research = true;
        active.seq = 0;
        current = { ...current, researchCheckpoint: checkpoint,
          researchPending: { runId, question, quote: frozenQuote, status: 'running' } };
        await putSession(current);
        // Publish the frozen run identity before its guarded live events can arrive.
        await hooks.onState(tabId);
        return researchStep(current, checkpoint, signal, hooks);
      }
      current = await attachImages(tabId, current, signal, hooks);
      const ctx = contextOf(current);
      const diagrams = effectiveSettings(config).diagrams === 'auto';
      const prepared = rawQuote === undefined ? current.quote ?? null
        : rawQuote === null ? null : prepareQuote(rawQuote, current.blocks);
      const quote = prepared ? { ...prepared, id: rawQuote === undefined ? prepared.id : quoteId ?? prepared.id } : null;
      const watch = watchProgress(
        hooks,
        tabId,
        current.blocks.map((block) => block.id),
      );
      const missingRequired = gate.level === 'required' && !/文中|本文|文章|原文|作者/.test(question);
      const unknown = { answer: '当前提供的原文无法确认这一问题。', source: 'unknown', citations: [], unanswered: ['缺少实时核验依据。'], references: [], followUps: [] };
      const parsed = missingRequired ? unknown : await callModel(
        answerMessages({
          title: current.title,
          url: current.url,
          contextJson: ctx.json,
          disclosure: describeCompleteness(current.completeness),
          history: topicTurns
            .slice(-LIMITS.maxHistoryTurns)
            .map((turn) => ({ question: turn.question, answer: turn.answer })),
          question,
          override: resolvePolicy('answer', config),
          networkContext: { gate, scope: 'article' },
          topic: { switched: topicSwitched },
          quote,
          diagrams,
        }),
        signal,
        watch.onProgress,
      );
      let clean = cleanAnswer(parsed, current.blocks);
      if (clean.ok && (clean.value.source !== 'original' && clean.value.source !== 'unknown' ||
          gate.level === 'required' && !clean.value.citations.length)) clean = cleanAnswer(unknown, current.blocks);
      if (!clean.ok) throw clean.error;
      const unanswered = [...clean.value.unanswered];
      const citations = clean.value.source === 'unknown' ? [] : withQuoteCitation(clean.value.citations, current.blocks, quote);
      const asked = [...topicTurns.map((turn) => turn.question), question];
      const followUps = clean.value.followUps.filter((item) => !hasAskedQuestion(asked, item.question));
      return writeBack(tabId, current, runId, (fresh) => ({
        ...fresh,
        activeTopicId: topicId,
        chat: [
          ...fresh.chat,
          {
            id: newId('t'),
            topicId,
            question,
            answer: gate.level === 'required' ? `${clean.value.answer}\n\n本题未联网核验，只依据当前提供的文章。` : clean.value.answer,
            source: clean.value.source,
            citations,
            unanswered,
            references: clean.value.references,
            quote: quote ?? undefined,
            followUps,
            ...(watch.reasoning() ? { reasoning: watch.reasoning() } : {}),
            at: Date.now(),
          },
        ].slice(-LIMITS.maxChatTurns),
        quote: quote && fresh.quote && (fresh.quote.id ?? fresh.quote.text) === (quote.id ?? quote.text)
          ? null : fresh.quote ?? null,
        state: 'READY',
        error: null,
        updatedAt: Date.now(),
      }));
    },
    hooks,
  );
}

function withQuoteCitation(
  citations: { blockId: string }[],
  blocks: { id: string }[],
  quote: Quote | null,
): { blockId: string }[] {
  if (!quote?.blockId) return citations;
  if (!blocks.some((block) => block.id === quote.blockId)) return citations;
  if (citations.some((item) => item.blockId === quote.blockId)) return citations;
  return [{ blockId: quote.blockId }, ...citations];
}

/** Same-run continuation is consumed before the first asynchronous boundary. */
async function resolveResearch(intent: Extract<Intent, { kind: 'resolveResearch' }>, hooks: RunnerHooks): Promise<AppError | null> {
  const active = controllers.get(intent.tabId);
  if (!active?.research || !active.waiting || active.sessionId !== intent.sessionId || active.runId !== intent.runId) {
    return appError('STALE_PAGE', '这次澄清已经失效，请重新提问。');
  }
  active.waiting = false;
  const session = await getSession(intent.tabId);
  if (!session || session.id !== intent.sessionId || session.run?.id !== intent.runId || !session.researchCheckpoint) {
    active.controller.abort();
    if (controllers.get(intent.tabId) === active) controllers.delete(intent.tabId);
    return appError('STALE_PAGE', '这次澄清已经失效，请重新提问。');
  }
  if (intent.mode === 'cancel') {
    active.controller.abort();
    active.waiting = true;
    await recoverInterruptedRun(intent.tabId); notifyState(hooks, intent.tabId); return null;
  }
  if (!intent.text.trim()) { active.waiting = true; return appError('INTERNAL', '请先回答澄清问题。'); }
  await putSession({ ...session, researchPending: session.researchPending ? { ...session.researchPending, status: 'running' } : undefined });
  return invokeRun(intent.tabId, 'answer', session, intent.runId, active.controller,
    async (current, _runId, signal) => {
      await hooks.onState(intent.tabId);
      return researchStep(current, session.researchCheckpoint!, signal, hooks,
        { mode: intent.mode as AgentResume['mode'], text: intent.text.trim().slice(0, LIMITS.maxQuestionChars) });
    }, hooks);
}

/** Events and completion use the same frozen identity; no async event can overtake completion. */
async function researchStep(session: PageSession, checkpoint: AgentCheckpoint, signal: AbortSignal,
  hooks: RunnerHooks, resume?: AgentResume): Promise<PageSession | null> {
  if (signal.aborted) throw appError('ABORTED', '已经停止。');
  const { identity, thinking } = checkpoint.snapshot;
  const active = controllers.get(identity.tabId)!;
  let events = Promise.resolve();
  const outcome = await executeResearch(checkpoint, signal, event => {
    if (signal.aborted || controllers.get(identity.tabId) !== active ||
        Object.entries(identity).some(([key, value]) => event.identity[key as keyof typeof identity] !== value) || event.seq <= (active.seq ?? 0)) return;
    active.seq = event.seq;
    events = events.then(async () => {
      await assertResearchCurrent(identity, thinking, signal, checkpoint.snapshot.searchProviderId, checkpoint.snapshot.outboundScope);
      if (controllers.get(identity.tabId) !== active) return;
      active.agent = event; hooks.onAgent?.(identity.tabId, event);
    });
    void events.catch(() => {});
  }, resume);
  await events;
  await assertResearchCurrent(identity, thinking, signal, checkpoint.snapshot.searchProviderId, checkpoint.snapshot.outboundScope);
  const fresh = await getSession(identity.tabId);
  if (!fresh || fresh.id !== identity.sessionId || fresh.run?.id !== identity.runId ||
      fresh.url !== identity.url || fresh.fingerprint !== identity.fingerprint || signal.aborted) return null;
  if (outcome.kind === 'waiting') {
    active.waiting = true;
    return { ...fresh, researchCheckpoint: outcome.checkpoint,
      researchPending: { runId: identity.runId, question: checkpoint.snapshot.question, quote: checkpoint.snapshot.quote,
        status: 'waiting', clarification: outcome.question, permissionOrigins: permissionOrigins(outcome.checkpoint) }, error: null };
  }
  if (outcome.degraded && outcome.checkpoint.waiting) {
    return { ...endRun(fresh, identity.runId), researchCheckpoint: undefined,
      researchPending: { runId: identity.runId, question: checkpoint.snapshot.question, quote: checkpoint.snapshot.quote,
        status: 'interrupted', clarification: outcome.checkpoint.waiting },
      error: appError('TIMEOUT', '这次澄清等待已过期，请重新提问。', true) };
  }
  const answer = toResearchAnswer(outcome);
  const quote = checkpoint.snapshot.quote;
  return { ...fresh, researchCheckpoint: undefined, researchPending: undefined,
    activeTopicId: checkpoint.snapshot.topicId ?? fresh.activeTopicId,
    chat: [...fresh.chat, { id: newId('t'), question: checkpoint.snapshot.question, ...answer,
      ...(checkpoint.snapshot.topicId ? { topicId: checkpoint.snapshot.topicId } : {}),
      quote: quote ?? undefined, followUps: [], at: Date.now() }].slice(-LIMITS.maxChatTurns),
    quote: quote && fresh.quote && (fresh.quote.id ?? fresh.quote.text) === (quote.id ?? quote.text) ? null : fresh.quote ?? null,
    state: 'READY', error: null, updatedAt: Date.now() };
}

/** A reconnect invalidates Agent work; ordinary QA keeps its existing reconnect behavior. */
export async function invalidateAllResearch(): Promise<void> {
  await Promise.all([...controllers].filter(([, active]) => active.research).map(([tabId]) => invalidateResearch(tabId)));
}

export async function invalidateResearch(tabId: number): Promise<void> {
  const active = controllers.get(tabId);
  if (!active?.research) return;
  active.controller.abort();
  const fresh = await getSession(tabId);
  if (fresh?.id === active.sessionId && fresh.run?.id === active.runId) {
    await putSession({ ...endRun(fresh, active.runId), researchCheckpoint: undefined,
      researchPending: fresh.researchPending ? { ...fresh.researchPending, status: 'interrupted' } : undefined,
      error: appError('INTERNAL', '研究已中断，请重新提问。', true) });
  }
  if (controllers.get(tabId) === active) controllers.delete(tabId);
}

type LearnInput = {
  userAnswer?: string;
  userChoices?: LearnChoiceAnswer[];
  hintUsed?: boolean;
  search?: boolean;
};

async function runLearnStart(tabId: number, goal: string, search: boolean, hooks: RunnerHooks): Promise<AppError | null> {
  const session = await getSession(tabId);
  if (!session) return appError('STALE_PAGE', '当前标签页没有可用的页面会话。', true);
  const blocked = canStartLearning(session);
  if (blocked) {
    await putSession({ ...session, error: blocked, updatedAt: Date.now() });
    notifyState(hooks, tabId);
    return blocked;
  }
  if (session.learning?.status === 'active') {
    return appError('BUSY', '当前已经有一个进行中的学习会话。', false);
  }

  const config = await readConfig();
  const settings = effectiveSettings(config);
  const frozen = freezeLearnPolicy({
    resolvedPolicy: resolvePolicy('learn', config),
    style: settings.learningStyle,
  });
  const nextGoal = goal.trim().slice(0, 200) || DEFAULT_LEARN_GOAL;
  const learning: LearningState = {
    goal: nextGoal,
    ...frozen,
    usedGoals: rememberLearnGoal(session.learning, nextGoal),
    used: 0,
    current: null,
    status: 'active',
    log: [],
  };
  await putSession({ ...session, learning, learningHistory: archiveLearning(session.learning, session.learningHistory), state: 'LEARNING', error: null, updatedAt: Date.now() });
  return runLearnStep(tabId, 'ask', { search }, hooks);
}

async function runAssist(
  tabId: number,
  assist: 'hint' | 'explain' | 'skip' | 'unknown',
  search: boolean,
  hooks: RunnerHooks,
): Promise<AppError | null> {
  if (assist === 'hint') {
    // 选择题轮没有提示路径：跳过或讲解才是可执行的动作。
    const session = await getSession(tabId);
    if (session?.learning?.current?.kind === 'quiz') {
      return appError('INTERNAL', '选择题这一轮没有提示。可以跳过这一轮，或直接看讲解。', false);
    }
  }
  if (assist === 'unknown') {
    const session = await getSession(tabId);
    const learning = session?.learning;
    if (!session || !learning || learning.status !== 'active') {
      return appError('INTERNAL', '当前没有进行中的学习会话。', false);
    }
    const mode = unknownAssistMode(learning);
    if (!mode) {
      return appError('INTERNAL', '这一轮请直接作答、跳过或看讲解。', false);
    }
    await putSession({
      ...session,
      learning: appendLearn(learning, { role: 'answer', text: '我不知道', independent: false }),
      updatedAt: Date.now(),
    });
    return runLearnStep(tabId, mode, { userAnswer: '我不知道', hintUsed: true, search }, hooks);
  }
  if (assist === 'skip') {
    // 跳过不发模型请求：只记录用户选择，然后换一个题目（FR-014）。
    const session = await getSession(tabId);
    const learning = session?.learning;
    if (!session || !learning || learning.status !== 'active') {
      return appError('INTERNAL', '当前没有进行中的学习会话。', false);
    }
    await putSession({
      ...session,
      learning: learning.current
        ? appendLearn({ ...learning, current: null }, { role: 'skip', text: '已跳过这个问题。' })
        : learning,
      updatedAt: Date.now(),
    });
    return runLearnStep(tabId, 'ask', { search }, hooks);
  }
  return runLearnStep(tabId, assist === 'hint' ? 'hint' : 'explain', { search }, hooks);
}

async function learningSupplement(
  tabId: number,
  session: PageSession,
  learning: LearningState,
  input: LearnInput,
  config: Awaited<ReturnType<typeof readConfig>>,
  runId: string,
  signal: AbortSignal,
  hooks: RunnerHooks,
): Promise<LearnSupplement | undefined> {
  const question = input.userAnswer?.trim() || (learning.current?.kind === 'open' ? learning.current.question : learning.goal);
  const search = input.search === true;
  const gate = evaluateSearchGate({
    question: question.slice(0, LIMITS.maxQuestionChars),
    pageTitle: session.title,
    quote: null,
    mode: search ? 'auto' : 'article',
    enabled: search,
    freshness: runtimeAgentSettings(config, browser.i18n?.getUILanguage() ?? globalThis.navigator?.language ?? 'en').freshness,
    now: new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  if (!search && gate.level === 'required') return { text: '本轮需要实时资料，但联网搜索未开启，当前未核验。', source: 'unverified' };
  if (!gate.canSearch || gate.level === 'ambiguous' || !config.search?.providerId) return undefined;

  const model = researchModelSelection(config);
  const settings = { ...runtimeAgentSettings(config, browser.i18n?.getUILanguage() ?? globalThis.navigator?.language ?? 'en'), enabled: true };
  const checkpoint = initialCheckpoint({
    identity: { tabId, sessionId: session.id, runId, url: session.url, fingerprint: session.fingerprint, modelProvider: model.modelProvider, modelId: model.modelId },
    thinking: model.thinking,
    searchProviderId: config.search.providerId,
    outboundScope: outboundScope(config),
    question: question.slice(0, LIMITS.maxQuestionChars),
    title: session.title,
    blocks: structuredClone(session.blocks),
    quote: null,
    history: learnHistory(learning).map(item => ({ question: item.question, answer: item.answer })),
    disclosure: describeCompleteness(session.completeness),
    gate,
    settings,
    policyVersion: SEARCH_AGENT_VERSION,
    answerPolicy: resolvePolicy('answer', config) ?? ANSWER_DEFAULT_POLICY,
    diagrams: effectiveSettings(config).diagrams === 'auto',
  }, Date.now());
  const active = controllers.get(tabId);
  if (!active || active.runId !== runId || active.sessionId !== session.id) return undefined;
  active.research = true;
  active.seq = 0;
  await putSession({ ...session, researchCheckpoint: checkpoint, researchPending: { runId, question: checkpoint.snapshot.question, quote: null, status: 'running' } });
  await hooks.onState(tabId);
  try {
    const outcome = await executeResearch(checkpoint, signal, event => {
      if (event.identity.runId === runId) hooks.onAgent?.(tabId, event);
    });
    if (outcome.kind !== 'finished' || outcome.degraded) return { text: '本轮联网资料未能完成核验。', source: 'unverified' };
    const answer = toResearchAnswer(outcome);
    if (answer.source !== 'extended' || !answer.references.length) return undefined;
    return { text: answer.answer, source: 'network', references: answer.webReferences, research: answer.research };
  } catch {
    return { text: '本轮联网资料未能完成核验。', source: 'unverified' };
  } finally {
    active.research = false;
    active.agent = undefined;
    const fresh = await getSession(tabId);
    if (fresh?.id === session.id && fresh.run?.id === runId) {
      await putSession({ ...fresh, researchCheckpoint: undefined, researchPending: undefined });
    }
  }
}

async function runLearnStep(
  tabId: number,
  mode: LearnMode,
  input: LearnInput,
  hooks: RunnerHooks,
): Promise<AppError | null> {
  const config = await readConfig();
  return withRun(
    tabId,
    'learn',
    async (session, runId, signal) => {
      const current = await attachImages(tabId, await adoptCurrentPage(tabId, session), signal, hooks);
      const learning = current.learning;
      if (!learning || learning.status !== 'active') {
        throw appError('INTERNAL', '当前没有进行中的学习会话。', false);
      }
      if ((mode === 'respond' || mode === 'hint' || mode === 'explain') && !learning.current) {
        throw appError('INTERNAL', '当前没有待回答的问题。', false);
      }

      const ctx = contextOf(current);
      const settings = effectiveSettings(config);
      const frozen = frozenLearnCall(learning, {
        policy: resolvePolicy('learn', config),
        style: settings.learningStyle,
      });
      const supplementContext = mode === 'close' ? undefined : await learningSupplement(tabId, current, learning, input, config, runId, signal, hooks);
      let next = await callLearn(
        current,
        learning,
        mode,
        input,
        ctx.json,
        signal,
        hooks,
        tabId,
        frozen.override,
        frozen.style,
        settings.diagrams === 'auto',
        supplementContext,
      );
      // 模型判断应当收束时，本轮直接补一次收束，不留给用户一个悬空状态（FR-012）。
      if (mode !== 'close' && !next.current && next.status === 'active') {
        next = await callLearn(
          current,
          next,
          'close',
          {},
          ctx.json,
          signal,
          hooks,
          tabId,
          frozen.override,
          frozen.style,
          settings.diagrams === 'auto',
          supplementContext,
        );
      }

      return writeBack(tabId, current, runId, (fresh) => ({
        ...fresh,
        learning: next,
        // 收束即回到 READY：问答 Tab 与“再来一轮”立即可用，不再需要一个退出动作（FR-011）。
        state: next.status === 'closed' ? 'READY' : 'LEARNING',
        error: null,
        updatedAt: Date.now(),
      }));
    },
    hooks,
  );
}

type LearnHistoryItem = {
  question: string;
  answer: string;
  verdict: string;
  hintUsed: boolean;
  target?: QuestionTarget;
  mastery?: string;
};

function learnHistory(learning: LearningState): LearnHistoryItem[] {
  const pairs: LearnHistoryItem[] = [];
  for (const entry of learning.log) {
    if (entry.role === 'question' || entry.role === 'quiz') {
      pairs.push({
        question: entry.text.split('\n')[0] ?? '',
        answer: '',
        verdict: '',
        hintUsed: false,
        target: entry.target ?? entry.quiz?.[0]?.target,
      });
      continue;
    }
    const last = pairs[pairs.length - 1];
    if (!last) continue;
    if (entry.role === 'answer') {
      last.answer = entry.text;
      last.hintUsed = entry.independent === false;
    } else if (entry.role === 'feedback') {
      last.verdict = entry.verdict ?? '';
      last.mastery = entry.mastery;
    }
  }
  return pairs.slice(-LIMITS.maxHistoryTurns * 2);
}

async function callLearn(
  session: PageSession,
  learning: LearningState,
  mode: LearnMode,
  input: LearnInput,
  contextJson: string,
  signal: AbortSignal,
  hooks: RunnerHooks,
  tabId: number,
  override: string | undefined,
  style: 'mixed' | 'quiz' | 'open',
  diagrams: boolean,
  supplementContext?: LearnSupplement,
): Promise<LearningState> {
  const watch = watchProgress(
    hooks,
    tabId,
    session.blocks.map((block) => block.id),
  );
  const parsed = await callModel(
    learnMessages({
      mode,
      title: session.title,
      contextJson,
      disclosure: describeCompleteness(session.completeness),
      goal: learning.goal,
      round: learning.used,
      history: learnHistory(learning),
      current: learning.current,
      userAnswer: input.userAnswer,
      userAnswers: input.userChoices,
      hintUsed: input.hintUsed ?? (learning.current?.kind === 'open' ? learning.current.hintUsed : false),
      override,
      style,
      diagrams,
      supplementalContext: supplementContext && supplementContext.source !== 'stable'
        ? { text: supplementContext.text, source: supplementContext.source }
        : undefined,
    }),
    signal,
    watch.onProgress,
  );
  const clean = cleanLearn(
    parsed,
    mode,
    learning.current?.kind,
    session.blocks.map((block) => block.id),
  );
  if (!clean.ok) throw clean.error;
  return attachCallReasoning(applyLearn(learning, clean.value, input), learning.log.length, watch.reasoning());
}

function openMastery(verdict: 'correct' | 'partial' | 'misconception' | 'unknown' | 'objection', independent: boolean): MasteryLabel {
  if (verdict === 'correct' && independent) return 'independent';
  if (verdict === 'correct' || verdict === 'partial') return 'basic';
  if (verdict === 'misconception') return 'review';
  return 'unverified';
}

function quizMastery(correct: number, total: number): MasteryLabel {
  if (total > 0 && correct === total) return 'basic';
  return correct > 0 ? 'review' : 'unverified';
}

function applyLearn(learning: LearningState, clean: LearnResult, input: LearnInput): LearningState {
  let next = learning;
  switch (clean.action) {
    case 'question':
      if (!nextQuestionAllowed(next)) return { ...next, current: null };
      next = appendLearn(
        { ...next, used: next.used + 1, current: { kind: 'open', question: clean.question, hintUsed: false, target: clean.target } },
        { role: 'question', text: clean.question, ...(clean.target ? { target: clean.target } : {}) },
      );
      break;
    case 'quiz':
      if (!nextQuestionAllowed(next)) return { ...next, current: null };
      next = appendLearn(
        {
          ...next,
          used: next.used + 1,
          current: { kind: 'quiz', questions: clean.questions, answerKey: clean.answerKey },
        },
        {
          role: 'quiz',
          quiz: clean.questions,
          text: clean.questions.map((question) => question.text).join('\n'),
        },
      );
      break;
    case 'feedback': {
      const hintUsed = next.current?.kind === 'open' ? next.current.hintUsed : false;
      const target = next.current?.kind === 'open' ? next.current.target : undefined;
      const mastery = openMastery(clean.verdict, !hintUsed);
      next = appendLearn({ ...next }, { role: 'answer', text: input.userAnswer ?? '', independent: !hintUsed });
      next = appendLearn(next, {
        role: 'feedback', text: clean.feedback, verdict: clean.verdict, mastery,
        ...(target ? { target } : {}), ...(clean.supplement ? { supplement: clean.supplement } : {}),
      });
      next = advance(next, clean.nextQuestion, clean.nextQuestionTarget);
      break;
    }
    case 'graded': {
      const current = next.current;
      if (!current || current.kind !== 'quiz') break;
      const chosenOf = (questionId: string) =>
        input.userChoices?.find((item) => item.questionId === questionId)?.choiceIds ?? [];
      const labelOf = (questionId: string, choiceId: string) =>
        current.questions
          .find((question) => question.id === questionId)
          ?.choices.find((choice) => choice.id === choiceId)?.label ?? choiceId;

      // 客观对错由程序按答案钥匙判定（不信任模型改判）。
      const graded = current.questions.map((question) => {
        const chosen = chosenOf(question.id);
        const key = current.answerKey.find((item) => item.questionId === question.id)?.answer ?? [];
        const correct = chosen.length === key.length && key.every((id) => chosen.includes(id));
        return { questionId: question.id, chosen, correct };
      });
      const score = { correct: graded.filter((item) => item.correct).length, total: graded.length };

      const answerText = current.questions
        .map((question) => {
          const chosen = chosenOf(question.id);
          const rendered = chosen.length ? chosen.map((id) => labelOf(question.id, id)).join('、') : '未作答';
          return `${question.text}｜我的答案：${rendered}`;
        })
        .join('\n');
      next = appendLearn({ ...next }, { role: 'answer', text: answerText, independent: true });

      const validIds = new Set(current.questions.map((question) => question.id));
      const notesById = new Map(clean.notes.filter((note) => validIds.has(note.questionId)).map((note) => [note.questionId, note.note]));
      const feedbackText = [
        `本轮 ${score.correct}/${score.total} 题正确。`,
        clean.analysis,
        ...graded.map((item) => {
          const why =
            notesById.get(item.questionId) ??
            current.answerKey.find((key) => key.questionId === item.questionId)?.why ??
            '';
          return `【${item.correct ? '答对' : '答错'}】${why}`;
        }),
      ]
        .filter(Boolean)
        .join('\n');
      next = appendLearn(next, {
        role: 'feedback', text: feedbackText, graded, score,
        mastery: quizMastery(score.correct, score.total),
        ...(clean.supplement ? { supplement: clean.supplement } : {}),
      });

      // 下一轮：选择题优先，其次开放问题；模型判断问清楚了才交给收束。
      const canContinue = nextQuestionAllowed(next);
      if (clean.nextQuiz && canContinue) {
        next = appendLearn(
          {
            ...next,
            used: next.used + 1,
            current: { kind: 'quiz', questions: clean.nextQuiz.questions, answerKey: clean.nextQuiz.answerKey },
          },
          {
            role: 'quiz',
            quiz: clean.nextQuiz.questions,
            text: clean.nextQuiz.questions.map((question) => question.text).join('\n'),
          },
        );
      } else if (clean.nextQuestion && canContinue) {
        next = advance(next, clean.nextQuestion, clean.nextQuestionTarget);
      } else {
        next = { ...next, current: null };
      }
      break;
    }
    case 'hint':
      next = appendLearn(
        {
          ...next,
          current: next.current?.kind === 'open'
            ? { ...next.current, question: clean.question, hintUsed: true }
            : next.current,
        },
        { role: 'hint', text: clean.hint },
      );
      break;
    case 'explain':
      next = appendLearn(next, { role: 'explain', text: clean.explanation, ...(clean.supplement ? { supplement: clean.supplement } : {}) });
      // 选择题轮讲解后继续作答（契约要求模型返回 nextQuestion:null）。
      if (next.current?.kind === 'quiz') break;
      next = advance(next, clean.nextQuestion, clean.nextQuestionTarget);
      break;
    case 'summary':
      // 继续方向做成可点的卡片（界面用 SuggestRow 渲染），不再拼成一句流水账。
      next = appendLearn(
        { ...next, current: null, status: 'closed', nextDirections: clean.nextDirections },
        {
          role: 'summary',
          text: clean.summary,
          ...(clean.supplement ? { supplement: clean.supplement } : {}),
          ...(clean.coveredTargets ? { coveredTargets: clean.coveredTargets } : {}),
          ...(clean.uncoveredTargets ? { uncoveredTargets: clean.uncoveredTargets } : {}),
        },
      );
      break;
  }
  return next;
}

/** 是否还有下一轮开放问题：模型给了下一问就接着问，直到它判断该收束（FR-012）。 */
function advance(learning: LearningState, nextQuestion: string | null, target?: QuestionTarget): LearningState {
  if (!nextQuestion || !nextQuestionAllowed(learning)) return { ...learning, current: null };
  return appendLearn(
    { ...learning, used: learning.used + 1, current: { kind: 'open', question: nextQuestion, hintUsed: false, target } },
    { role: 'question', text: nextQuestion, ...(target ? { target } : {}) },
  );
}
