import type { BlocksPayload, Completeness, EvidenceBlock } from './blocks';
import { appError, type AppError } from './errors';
import { LIMITS } from './limits';

/**
 * 页面会话：正文、摘要、气泡、对话与学习状态只在当前浏览会话保留（FR-030）。
 * 这里的函数保持纯函数，持久化由 background/store.ts 负责。
 */

export type RequestKind = 'guide' | 'answer' | 'learn';

export type SessionState = 'READY_TO_START' | 'ANALYZING' | 'READY' | 'LEARNING' | 'STALE' | 'ERROR';

export type BubbleKind = 'concept' | 'reason' | 'premise' | 'example' | 'counter' | 'boundary';
export type Bubble = { id: string; question: string; kind: BubbleKind };

/** 输出来源五分类（FR-010）。 */
export type AnswerSource = 'original' | 'supplement' | 'example' | 'extended' | 'unknown';

/** 引文只保存块 id；文本一律由程序从本地块取出（FR-016）。 */
export type Citation = { blockId: string };

export type ChatTurn = {
  id: string;
  question: string;
  answer: string;
  source: AnswerSource;
  citations: Citation[];
  unanswered: string[];
  at: number;
};

/** 五类回答判断（FR-013）。 */
export type Verdict = 'correct' | 'partial' | 'misconception' | 'unknown' | 'objection';

export type LearnRole =
  | 'question'
  | 'answer'
  | 'feedback'
  | 'hint'
  | 'explain'
  | 'skip'
  | 'summary'
  | 'note';

/** 学习时间线：界面直接渲染这条记录，不再维护第二份状态。 */
export type LearnEntry = {
  role: LearnRole;
  text: string;
  verdict?: Verdict;
  /** 该回答是否在无提示条件下完成（FR-014：经提示后完成不记为独立掌握）。 */
  independent?: boolean;
  at: number;
};

export type LearningState = {
  goal: string;
  /** 启动时固定的教学提示词版本；进行中的会话不随覆盖变化（FR-028）。 */
  promptVersion: string;
  /** 启动时固定的提问预算；旧会话可能没有此字段，此时用默认值。 */
  budget?: number;
  /** 已用提问预算（按“提出问题”计数）。 */
  used: number;
  /** 当前待回答的问题。 */
  current: { question: string; hintUsed: boolean } | null;
  status: 'active' | 'closed';
  log: LearnEntry[];
};

export type Run = { id: string; kind: RequestKind; startedAt: number };

export type PageSession = {
  id: string;
  tabId: number;
  url: string;
  title: string;
  fingerprint: string;
  state: SessionState;
  blocks: EvidenceBlock[];
  completeness: Completeness;
  guide: { summary: string; bubbles: Bubble[] } | null;
  chat: ChatTurn[];
  learning: LearningState | null;
  /** 在途请求；写回必须与之匹配，否则丢弃迟到结果（FR-024）。 */
  run: Run | null;
  error: AppError | null;
  updatedAt: number;
};

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function createSession(tabId: number, page: BlocksPayload): PageSession {
  return {
    id: newId('s'),
    tabId,
    url: page.url,
    title: page.title,
    fingerprint: page.fingerprint,
    state: 'ANALYZING',
    blocks: page.blocks,
    completeness: page.completeness,
    guide: null,
    chat: [],
    learning: null,
    run: null,
    error: null,
    updatedAt: Date.now(),
  };
}

/** 新建但尚未读取正文的空会话（READY_TO_START）。 */
export function emptySession(tabId: number, url: string): PageSession {
  return {
    id: newId('s'),
    tabId,
    url,
    title: '',
    fingerprint: '',
    state: 'READY_TO_START',
    blocks: [],
    completeness: {
      scope: 'readability-article',
      text: { status: 'not-present', found: 0, captured: 0 },
      tables: { status: 'not-present', found: 0, captured: 0 },
      images: { status: 'not-present', found: 0, captured: 0 },
      frames: { status: 'not-present', found: 0, captured: 0 },
      excludedBlocks: 0,
      truncated: false,
      warnings: [],
    },
    guide: null,
    chat: [],
    learning: null,
    run: null,
    error: null,
    updatedAt: Date.now(),
  };
}

/** 页面身份或内容版本变化：旧结果立即陈旧，正文不再作为当前页上下文（FR-005/FR-024）。 */
export function markStale(session: PageSession, url?: string): PageSession {
  return {
    ...session,
    url: url ?? session.url,
    title: url && url !== session.url ? '' : session.title,
    fingerprint: '',
    state: 'STALE',
    blocks: [],
    completeness: emptySession(session.tabId, url ?? session.url).completeness,
    guide: null,
    chat: [],
    learning: null,
    run: null,
    error: null,
    updatedAt: Date.now(),
  };
}

export type BeginResult = { ok: true; session: PageSession; run: Run } | { ok: false; error: AppError };

/** 开始一次在途请求；同一标签页同时只允许一个（FR-039）。 */
export function beginRun(session: PageSession, kind: RequestKind): BeginResult {
  if (session.run) {
    return {
      ok: false,
      error: appError('BUSY', '上一步还在进行中。先点停止，再做别的。', true),
    };
  }
  const run: Run = { id: newId('r'), kind, startedAt: Date.now() };
  const state: SessionState = kind === 'guide' ? 'ANALYZING' : session.state;
  return { ok: true, run, session: { ...session, run, error: null, state, updatedAt: Date.now() } };
}

/** 结束在途请求（成功、失败或取消都走这里）。 */
export function endRun(session: PageSession, runId: string): PageSession {
  if (session.run?.id !== runId) return session;
  return { ...session, run: null, updatedAt: Date.now() };
}

/**
 * 写回判定：只有同一次在途请求、且会话未被替换时才允许写入（FR-024）。
 * 页面身份与内容版本另行由内容脚本核对，见 background/runner.ts。
 */
export function acceptsWriteBack(session: PageSession, runId: string): boolean {
  return session.run?.id === runId;
}

/** 停止后的状态恢复（FR-023）：三类请求各自的落点。 */
export function stateAfterStop(session: PageSession, kind: RequestKind): SessionState {
  if (kind === 'guide') return 'READY_TO_START';
  if (kind === 'learn') return 'LEARNING';
  return 'READY';
}

/**
 * 失败后的状态恢复（FR-035）：只有“还没有首屏”才需要用户重新开始，
 * 问答或学习失败时保留已有会话与已完成记录，只显示可执行的错误信息。
 */
export function stateAfterFailure(session: PageSession, kind: RequestKind): SessionState {
  if (kind === 'guide') return 'ERROR';
  if (kind === 'learn') return session.learning ? 'LEARNING' : 'READY';
  return 'READY';
}

export function canStartLearning(session: PageSession): AppError | null {
  if (session.state !== 'READY') {
    return appError('STALE_PAGE', '这一页还没有读，先点开始伴读。', false);
  }
  if (!session.blocks.length) {
    return appError('EXTRACT_FAILED', '这一页读不出内容，没法开始提问。', false);
  }
  return null;
}

export function remainingBudget(learning: LearningState): number {
  return Math.max(0, (learning.budget ?? LIMITS.learningBudget) - learning.used);
}

/** 预算用尽后不再提问，先收束，由用户明确决定是否续开（FR-012/FR-039）。 */
export function nextQuestionAllowed(learning: LearningState): boolean {
  return remainingBudget(learning) > 0;
}

export function appendLearn(learning: LearningState, entry: Omit<LearnEntry, 'at'>): LearningState {
  return { ...learning, log: [...learning.log, { ...entry, at: Date.now() }] };
}
