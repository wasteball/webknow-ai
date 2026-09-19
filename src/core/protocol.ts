import type { Completeness, DomAnchor } from './blocks';
import type { AppError } from './errors';
import type { SummaryLength } from './limits';
import type { FontSize, PromptOverrides } from './settings';
import type { Skill, SkillChoice } from './skills';
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

/** 界面可见的生效设置（产品化改造 F2/F6）。覆盖内容原样展示，空 = 用默认。 */
export type PanelSettings = {
  model: string;
  prompts: PromptOverrides;
  skillChoices: SkillChoice;
  /** 用户自建的技能；内置技能由界面直接从 core/skills 读取。 */
  customSkills: Skill[];
  learningBudget: number;
  learningStyle: 'mixed' | 'quiz' | 'open';
  /** 联网搜索（F3）：只暴露状态，凭证永不进界面。 */
  search: { enabled: boolean; providerName: string | null; hasCredentials: boolean };
  /** 知识库（K-ima）：只暴露状态；凭证永不进界面。 */
  ima: { enabled: boolean; kbName: string | null };
  maxBubbles: number;
  summaryLength: SummaryLength;
  fontSize: FontSize;
};

export type PanelState = {
  tabId: number | null;
  pageUrl: string | null;
  pageTitle: string;
  /** 当前站点读取权限；unknown 表示无法读取地址（尚未授权）。 */
  permission: 'granted' | 'missing' | 'unknown';
  phase: Phase;
  sessionState: SessionState | null;
  hasKey: boolean;
  settings: PanelSettings;
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
  | { type: 'ask'; tabId: number; question: string; search?: boolean }
  | { type: 'explore'; tabId: number; bubbleId: string }
  | { type: 'learnStart'; tabId: number; goal: string }
  | { type: 'learnAnswer'; tabId: number; text: string; choices?: { questionId: string; choiceIds: string[] }[] }
  | { type: 'learnAssist'; tabId: number; action: 'hint' | 'explain' | 'skip' }
  | { type: 'learnEnd'; tabId: number }
  | { type: 'jump'; tabId: number; blockId: string }
  | { type: 'clearSession'; tabId: number }
  | { type: 'clearAllSessions' }
  | { type: 'saveKey'; key: string }
  | { type: 'testKey'; key: string }
  | { type: 'deleteKey' }
  | { type: 'saveSettings'; patch: import('./settings').SettingsPatch }
  | { type: 'saveSkill'; skill: { id?: string; name: string; description: string; target: 'guide' | 'answer' | 'learn'; body: string } }
  | { type: 'deleteSkill'; id: string }
  | { type: 'saveSearchConfig'; providerId: string | null; credentials?: Record<string, string> }
  | { type: 'testSearch'; providerId: string; credentials?: Record<string, string> }
  | { type: 'saveImaConfig'; clientId?: string; apiKey?: string }
  | { type: 'saveImaKb'; kbId: string; kbName: string }
  | { type: 'listImaKb'; credentials?: { clientId: string; apiKey: string } }
  | { type: 'deleteImaConfig' }
  | { type: 'saveToIma'; tabId: number }
  | { type: 'listModels' }
  | { type: 'confirmOutbound' };

export type Reply =
  | { ok: true; message?: string; data?: { models?: string[]; imaKbItems?: { id: string; name: string; contentCount: number }[] } }
  | { ok: false; error: AppError };

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
