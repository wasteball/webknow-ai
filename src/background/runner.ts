import { buildContext, describeCompleteness } from '../core/blocks';
import { appError, type AppError } from '../core/errors';
import { LIMITS } from '../core/limits';
import { answerMessages } from '../core/prompts/answer';
import { guideMessages, summaryCharsFor } from '../core/prompts/guide';
import { LEARN_VERSION, learnMessages, type LearnMode } from '../core/prompts/learn';
import { searchWithProvider } from '../core/search/registry';
import type { SearchResult } from '../core/search/types';
import { effectiveSettings } from '../core/settings';
import { resolvePolicy } from '../core/skills';
import {
  acceptsWriteBack,
  appendLearn,
  beginRun,
  canStartLearning,
  endRun,
  markStale,
  newId,
  nextQuestionAllowed,
  stateAfterFailure,
  stateAfterStop,
  type LearningState,
  type PageSession,
  type RequestKind,
} from '../core/session';
import { cleanAnswer, cleanGuide, cleanLearn, type LearnResult } from '../core/validate';
import { callModel } from './model';
import { pageStillMatches, toAppError } from './page';
import { getSession, putSession, readConfig, readSearchCredentials, type Config } from './store';

/**
 * 请求流水线（三类请求共用一条）：
 *   守卫 → 组装上下文 → 提示词策略 → 模型调用 → 结构校验 → 引用校验 → 写回守卫 → 持久化
 * 新增能力只需要新增策略文件与校验器，不需要改这条流水线（FR-026/FR-029）。
 */

export type Intent =
  | { kind: 'guide'; tabId: number }
  | { kind: 'ask'; tabId: number; question: string; search?: boolean }
  | { kind: 'learnStart'; tabId: number; goal: string }
  | { kind: 'learnAnswer'; tabId: number; text: string; choices?: LearnChoiceAnswer[] }
  | { kind: 'learnAssist'; tabId: number; assist: 'hint' | 'explain' | 'skip' }
  | { kind: 'learnEnd'; tabId: number };

/** 选择题作答：一题多个选项 id。 */
export type LearnChoiceAnswer = { questionId: string; choiceIds: string[] };

export type RunnerHooks = {
  onState: (tabId: number) => void;
  onProgress: (tabId: number, chars: number) => void;
};

type Task = (
  session: PageSession,
  runId: string,
  signal: AbortSignal,
) => Promise<PageSession | null>;

/** 每个标签页同时只允许一个在途请求（FR-039）。 */
const controllers = new Map<number, AbortController>();

export function abortRun(tabId: number): boolean {
  const controller = controllers.get(tabId);
  if (!controller) return false;
  controller.abort();
  controllers.delete(tabId);
  return true;
}

export async function handleIntent(intent: Intent, hooks: RunnerHooks): Promise<AppError | null> {
  switch (intent.kind) {
    case 'guide':
      return runGuide(intent.tabId, hooks);
    case 'ask':
      return runAsk(intent.tabId, intent.question, intent.search === true, hooks);
    case 'learnStart':
      return runLearnStart(intent.tabId, intent.goal, hooks);
    case 'learnAnswer':
      return runLearnStep(intent.tabId, 'respond', { userAnswer: intent.text, userChoices: intent.choices }, hooks);
    case 'learnAssist':
      return runAssist(intent.tabId, intent.assist, hooks);
    case 'learnEnd':
      return runLearnStep(intent.tabId, 'close', {}, hooks);
  }
}

async function withRun(
  tabId: number,
  kind: RequestKind,
  task: Task,
  hooks: RunnerHooks,
): Promise<AppError | null> {
  const session = await getSession(tabId);
  if (!session) {
    return appError('STALE_PAGE', '当前标签页没有可用的页面会话。请重新开始伴读。', true);
  }
  const begun = beginRun(session, kind);
  if (!begun.ok) {
    await putSession({ ...session, error: begun.error, updatedAt: Date.now() });
    hooks.onState(tabId);
    return begun.error;
  }

  const controller = new AbortController();
  controllers.set(tabId, controller);
  await putSession(begun.session);
  // 用户触发后立即进入等待态（NFR-001），不等第一个字节。
  hooks.onState(tabId);

  let failure: AppError | null = null;
  try {
    const next = await task(begun.session, begun.run.id, controller.signal);
    if (next) await putSession(next);
  } catch (error) {
    failure = toAppError(error);
    const fresh = await getSession(tabId);
    if (fresh && acceptsWriteBack(fresh, begun.run.id)) {
      const stopped = failure.code === 'ABORTED';
      await putSession({
        ...endRun(fresh, begun.run.id),
        state: stopped ? stateAfterStop(fresh, kind) : stateAfterFailure(fresh, kind),
        error: stopped ? null : failure,
        updatedAt: Date.now(),
      });
    }
  } finally {
    controllers.delete(tabId);
    const fresh = await getSession(tabId);
    if (fresh?.run?.id === begun.run.id) await putSession(endRun(fresh, begun.run.id));
    hooks.onState(tabId);
  }
  return failure;
}

/** 写回守卫：页面身份/内容版本仍在，且会话与请求身份未变，否则丢弃迟到结果（FR-024）。 */
async function writeBack(
  tabId: number,
  session: PageSession,
  runId: string,
  mutate: (fresh: PageSession) => PageSession,
): Promise<PageSession | null> {
  if (!(await pageStillMatches(tabId, session))) {
    const fresh = await getSession(tabId);
    if (fresh && acceptsWriteBack(fresh, runId)) await putSession(markStale(fresh));
    return null;
  }
  const fresh = await getSession(tabId);
  if (!fresh || !acceptsWriteBack(fresh, runId)) return null;
  return mutate(fresh);
}

function progress(hooks: RunnerHooks, tabId: number) {
  return (chars: number) => hooks.onProgress(tabId, chars);
}

function contextOf(session: PageSession) {
  const ctx = buildContext(session.blocks);
  if (!ctx.ok) throw ctx.error;
  return ctx;
}

async function runGuide(tabId: number, hooks: RunnerHooks): Promise<AppError | null> {
  const config = await readConfig();
  const settings = effectiveSettings(config);
  return withRun(
    tabId,
    'guide',
    async (session, runId, signal) => {
      const ctx = contextOf(session);
      const parsed = await callModel(
        guideMessages({
          title: session.title,
          url: session.url,
          contextJson: ctx.json,
          disclosure: describeCompleteness(session.completeness),
          override: resolvePolicy('guide', config),
          maxBubbles: settings.maxBubbles,
          summaryMaxChars: summaryCharsFor(settings.summaryLength),
        }),
        signal,
        progress(hooks, tabId),
      );
      const clean = cleanGuide(parsed, settings.maxBubbles);
      if (!clean.ok) throw clean.error;
      // 首屏结果只在页面身份与内容版本仍然一致时写回（FR-024）。
      return writeBack(tabId, session, runId, (fresh) => ({
        ...fresh,
        guide: clean.value,
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
  searchRequested: boolean,
  hooks: RunnerHooks,
): Promise<AppError | null> {
  const question = rawQuestion.trim().slice(0, LIMITS.maxQuestionChars);
  if (!question) return appError('INTERNAL', '问题为空，未发送任何请求。');

  const config = await readConfig();
  return withRun(
    tabId,
    'answer',
    async (session, runId, signal) => {
      const ctx = contextOf(session);

      // 联网搜索（F3）：失败或无结果时如实降级，只用文章本身回答，不阻断整个请求。
      let webResults: SearchResult[] = [];
      let searchFailed = false;
      if (searchRequested) {
        const search = await performSearch(config, question, signal);
        if (search.ok) webResults = search.results;
        else searchFailed = true;
      }

      const parsed = await callModel(
        answerMessages({
          title: session.title,
          url: session.url,
          contextJson: ctx.json,
          disclosure: describeCompleteness(session.completeness),
          history: session.chat
            .slice(-LIMITS.maxHistoryTurns)
            .map((turn) => ({ question: turn.question, answer: turn.answer })),
          question,
          override: resolvePolicy('answer', config),
          webResults: webResults.length ? webResults : undefined,
        }),
        signal,
        progress(hooks, tabId),
      );
      const clean = cleanAnswer(parsed, session.blocks, webResults);
      if (!clean.ok) throw clean.error;
      const unanswered = [...clean.value.unanswered];
      if (searchFailed || (webResults.length === 0 && searchRequested)) {
        unanswered.push('联网搜索没有可用的结果，这次只依据文章本身回答。');
      }
      return writeBack(tabId, session, runId, (fresh) => ({
        ...fresh,
        chat: [
          ...fresh.chat,
          {
            id: newId('t'),
            question,
            answer: clean.value.answer,
            source: clean.value.source,
            citations: clean.value.citations,
            unanswered,
            references: clean.value.references,
            at: Date.now(),
          },
        ].slice(-LIMITS.maxChatTurns),
        state: 'READY',
        error: null,
        updatedAt: Date.now(),
      }));
    },
    hooks,
  );
}

/** 执行一次联网搜索；只外发搜索词，不发送正文（F3）。 */
async function performSearch(
  config: Config,
  question: string,
  signal: AbortSignal,
): Promise<{ ok: true; results: SearchResult[] } | { ok: false }> {
  const providerId = config.search?.providerId;
  if (!providerId) return { ok: false };
  try {
    const credentials = await readSearchCredentials(providerId);
    const results = await searchWithProvider({
      providerId,
      config: credentials,
      query: question.slice(0, 200),
      count: LIMITS.searchResultsCount,
      signal,
    });
    return { ok: true, results };
  } catch {
    return { ok: false };
  }
}

type LearnInput = {
  userAnswer?: string;
  userChoices?: LearnChoiceAnswer[];
  hintUsed?: boolean;
};

async function runLearnStart(tabId: number, goal: string, hooks: RunnerHooks): Promise<AppError | null> {
  const session = await getSession(tabId);
  if (!session) return appError('STALE_PAGE', '当前标签页没有可用的页面会话。', true);
  const blocked = canStartLearning(session);
  if (blocked) {
    await putSession({ ...session, error: blocked, updatedAt: Date.now() });
    hooks.onState(tabId);
    return blocked;
  }
  if (session.learning?.status === 'active') {
    return appError('BUSY', '当前已经有一个进行中的学习会话。', false);
  }

  const config = await readConfig();
  const settings = effectiveSettings(config);
  const learning: LearningState = {
    goal: goal.trim().slice(0, 200) || '理解这篇文章的核心内容',
    // 启动时固定提示词版本与预算：进行中的会话不随之后的设置变化（FR-028）。
    promptVersion: resolvePolicy('learn', config) ? 'custom' : LEARN_VERSION,
    budget: settings.learningBudget,
    used: 0,
    current: null,
    status: 'active',
    log: [],
  };
  await putSession({ ...session, learning, state: 'LEARNING', error: null, updatedAt: Date.now() });
  return runLearnStep(tabId, 'ask', {}, hooks);
}

async function runAssist(
  tabId: number,
  assist: 'hint' | 'explain' | 'skip',
  hooks: RunnerHooks,
): Promise<AppError | null> {
  if (assist === 'hint') {
    // 选择题轮没有提示路径：跳过或讲解才是可执行的动作。
    const session = await getSession(tabId);
    if (session?.learning?.current?.kind === 'quiz') {
      return appError('INTERNAL', '选择题这一轮没有提示。可以跳过这一轮，或直接看讲解。', false);
    }
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
      learning: appendLearn({ ...learning, current: null }, { role: 'skip', text: '已跳过这个问题。' }),
      updatedAt: Date.now(),
    });
    return runLearnStep(tabId, 'ask', {}, hooks);
  }
  return runLearnStep(tabId, assist === 'hint' ? 'hint' : 'explain', {}, hooks);
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
      const learning = session.learning;
      if (!learning || learning.status !== 'active') {
        throw appError('INTERNAL', '当前没有进行中的学习会话。', false);
      }
      if ((mode === 'respond' || mode === 'hint' || mode === 'explain') && !learning.current) {
        throw appError('INTERNAL', '当前没有待回答的问题。', false);
      }

      const ctx = contextOf(session);
      const style = effectiveSettings(config).learningStyle;
      let next = await callLearn(
        session,
        learning,
        mode,
        input,
        ctx.json,
        signal,
        hooks,
        tabId,
        resolvePolicy('learn', config),
        style,
      );
      // 预算用尽或模型判断应当收束时，本轮直接补一次收束，不留给用户一个悬空状态（FR-012）。
      if (mode !== 'close' && !next.current && next.status === 'active') {
        next = await callLearn(
          session,
          next,
          'close',
          {},
          ctx.json,
          signal,
          hooks,
          tabId,
          resolvePolicy('learn', config),
          style,
        );
      }

      return writeBack(tabId, session, runId, (fresh) => ({
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
): Promise<LearningState> {
  const parsed = await callModel(
    learnMessages({
      mode,
      title: session.title,
      contextJson,
      disclosure: describeCompleteness(session.completeness),
      goal: learning.goal,
      used: learning.used,
      budget: learning.budget ?? LIMITS.learningBudget,
      history: learning.log
        .filter((entry) => entry.role === 'question' || entry.role === 'quiz' || entry.role === 'answer')
        .slice(-LIMITS.maxHistoryTurns * 2)
        .reduce<{ question: string; answer: string; verdict: string; hintUsed: boolean }[]>(
          (pairs, entry) => {
            if (entry.role === 'question' || entry.role === 'quiz') {
              pairs.push({
                question: entry.text.split('\n')[0] ?? '',
                answer: '',
                verdict: '',
                hintUsed: false,
              });
            } else {
              const last = pairs[pairs.length - 1];
              if (last) {
                last.answer = entry.text;
                last.hintUsed = entry.independent === false;
              }
            }
            return pairs;
          },
          []),
      current: learning.current,
      userAnswer: input.userAnswer,
      userAnswers: input.userChoices,
      hintUsed: input.hintUsed ?? (learning.current?.kind === 'open' ? learning.current.hintUsed : false),
      override,
      style,
    }),
    signal,
    progress(hooks, tabId),
  );
  const clean = cleanLearn(parsed, mode, learning.current?.kind);
  if (!clean.ok) throw clean.error;
  return applyLearn(learning, clean.value, input);
}

function applyLearn(learning: LearningState, clean: LearnResult, input: LearnInput): LearningState {
  let next = learning;
  switch (clean.action) {
    case 'question':
      next = appendLearn(
        { ...next, used: next.used + 1, current: { kind: 'open', question: clean.question, hintUsed: false } },
        { role: 'question', text: clean.question },
      );
      break;
    case 'quiz':
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
      next = appendLearn({ ...next }, { role: 'answer', text: input.userAnswer ?? '', independent: !hintUsed });
      next = appendLearn(next, {
        role: 'feedback',
        text: clean.feedback,
        verdict: clean.verdict,
      });
      next = advance(next, clean.nextQuestion);
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

      const notesById = new Map(clean.notes.map((note) => [note.questionId, note.note]));
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
      next = appendLearn(next, { role: 'feedback', text: feedbackText, graded, score });

      // 下一轮：选择题优先，其次开放问题；预算用尽则交给收束。
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
        next = advance(next, clean.nextQuestion);
      } else {
        next = { ...next, current: null };
      }
      break;
    }
    case 'hint':
      next = appendLearn(
        {
          ...next,
          current: { kind: 'open', question: clean.question, hintUsed: true },
        },
        { role: 'hint', text: clean.hint },
      );
      break;
    case 'explain':
      next = appendLearn(next, { role: 'explain', text: clean.explanation });
      // 选择题轮讲解后继续作答（契约要求模型返回 nextQuestion:null）。
      if (next.current?.kind === 'quiz') break;
      next = advance(next, clean.nextQuestion);
      break;
    case 'summary':
      next = appendLearn({ ...next, current: null, status: 'closed' }, { role: 'summary', text: clean.summary });
      if (clean.nextDirections.length) {
        next = appendLearn(next, {
          role: 'note',
          text: `可以继续的方向：${clean.nextDirections.join('；')}`,
        });
      }
      break;
  }
  return next;
}

/** 是否还有下一轮开放问题：预算用尽时不再提问，交给收束（FR-012/FR-039）。 */
function advance(learning: LearningState, nextQuestion: string | null): LearningState {
  if (!nextQuestion || !nextQuestionAllowed(learning)) return { ...learning, current: null };
  return appendLearn(
    { ...learning, used: learning.used + 1, current: { kind: 'open', question: nextQuestion, hintUsed: false } },
    { role: 'question', text: nextQuestion },
  );
}
