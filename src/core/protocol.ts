import type { Completeness, DomAnchor } from './blocks';
import type { AppError } from './errors';
import type { Bubble, ChatTurn, LearningState, RequestKind, SessionState } from './session';

/** 侧栏可见的页面状态（PRD 4.2）。由配置、权限与会话状态共同推导。 */
export type Phase =
  | 'UNCONFIGURED'
  | 'PERMISSION_REQUIRED'
  | 'READY_TO_START'
  | 'ANALYZING'
  | 'READY'
  | 'LEARNING'
  | 'STALE'
  | 'UNSUPPORTED'
  | 'ERROR';

export type PanelState = {
  tabId: number | null;
  pageUrl: string | null;
  pageTitle: string;
  /** 当前站点读取权限；unknown 表示无法读取地址（尚未授权）。 */
  permission: 'granted' | 'missing' | 'unknown';
  phase: Phase;
  sessionState: SessionState | null;
  hasKey: boolean;
  teachingPromptIsCustom: boolean;
  /** 用户自己的教学提示词覆盖；没有覆盖时为空字符串。 */
  teachingPrompt: string;
  outboundConfirmed: boolean;
  completeness: Completeness | null;
  guide: { summary: string; bubbles: Bubble[] } | null;
  chat: ChatTurn[];
  learning: LearningState | null;
  busy: { kind: RequestKind; chars: number } | null;
  error: AppError | null;
  budget: { used: number; total: number };
  /** 页面不支持时给用户的原因说明。 */
  unsupportedReason: string | null;
};

export type Command =
  | { type: 'attach'; tabId: number | null }
  | { type: 'start'; tabId: number }
  | { type: 'stop'; tabId: number }
  | { type: 'ask'; tabId: number; question: string }
  | { type: 'explore'; tabId: number; bubbleId: string }
  | { type: 'learnStart'; tabId: number; goal: string }
  | { type: 'learnAnswer'; tabId: number; text: string }
  | { type: 'learnAssist'; tabId: number; action: 'hint' | 'explain' | 'skip' }
  | { type: 'learnEnd'; tabId: number }
  | { type: 'learnExit'; tabId: number }
  | { type: 'jump'; tabId: number; blockId: string }
  | { type: 'clearSession'; tabId: number }
  | { type: 'clearAllSessions' }
  | { type: 'saveKey'; key: string }
  | { type: 'testKey'; key: string }
  | { type: 'deleteKey' }
  | { type: 'saveTeachingPrompt'; text: string }
  | { type: 'resetTeachingPrompt' }
  | { type: 'confirmOutbound' };

export type Reply = { ok: true; message?: string } | { ok: false; error: AppError };

export type Event =
  | { type: 'state'; state: PanelState }
  | { type: 'progress'; chars: number }
  | { type: 'reply'; id: number; reply: Reply };

export type PortRequest = { id: number; command: Command };

/** 后台 → 内容脚本的请求。内容脚本只做与当前 DOM 有关的事。 */
export type ContentRequest =
  | { type: 'extract' }
  | { type: 'fingerprint' }
  | { type: 'watch' }
  | { type: 'jump'; anchor: DomAnchor };

export type ContentReply =
  | { ok: true; data: unknown }
  | { ok: false; error: AppError };
