import type { Completeness, DomAnchor } from './blocks';
import type { AppError } from './errors';
import type { SummaryLength } from './limits';
import type { ProviderId } from './model-providers';
import type { ThinkingLevel } from './model-thinking';
import type { DiagramMode, FontSize, PromptOverrides } from './settings';
import type { Skill } from './skills';
import type { Quote } from './quote';
import type { AgentEvent, AgentSettings, ResearchSummary } from './search/agent-types';
import type { ResearchPending, Bubble, ChatTurn, LearningHistory, LearningState, RequestKind, SessionState } from './session';

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
  /** 用户自建的写法模板；内置模板由界面直接从 core/skills 读取。 */
  customSkills: Skill[];
  learningStyle: 'mixed' | 'quiz' | 'open';
  /** 当前用哪家模型供应商、每家配没配好钥匙、每家各自选的模型。
      Key 本身永不进界面——这里只有布尔值。 */
  provider: ProviderId;
  providerKeys: Record<ProviderId, boolean>;
  models: Partial<Record<ProviderId, string>>;
  /** 联网搜索（F3）：只暴露状态，凭证永不进界面。 */
  search: { enabled: boolean; providerName: string | null; hasCredentials: boolean;
    agent: AgentSettings; sourceCapabilities: { providerContent: boolean; directRead: boolean; directReadReason: string | null };
    receiver?: string | null };
  /** 知识库（K-ima）：只暴露状态；凭证永不进界面。 */
  ima: { enabled: boolean; kbName: string | null };
  maxBubbles: number;
  summaryLength: SummaryLength;
  fontSize: FontSize;
  /** 回答里的图表：auto / off。 */
  diagrams: DiagramMode;
  /** 当前模型的思考档。null 表示这个模型没有这一项。 */
  thinking: ThinkingLevel | null;
};

export type PanelState = {
  sessionId?: string | null;
  tabId: number | null;
  pageUrl: string | null;
  pageTitle: string;
  /** 是否已经能读当前页：点过工具栏打开产品就会 granted；unknown 表示还没拿到地址。 */
  permission: 'granted' | 'missing' | 'unknown';
  phase: Phase;
  sessionState: SessionState | null;
  hasKey: boolean;
  settings: PanelSettings;
  outboundConfirmed: boolean;
  completeness: Completeness | null;
  guide: { summary: string; bubbles: Bubble[]; reasoning?: string } | null;
  chat: ChatTurn[];
  learning: LearningState | null;
  learningHistory?: LearningHistory[];
  /** 划在网页上、正准备提问的原文。 */
  quote: Quote | null;
  /** Only program-generated pending state and content-free research metadata are exposed. */
  researchPending?: ResearchPending;
  researchDetails?: ResearchSummary;
  /** draft 是正在写的读者正文；reasoning 是同一轮的思考过程。引用和后续卡片不在这里。 */
  busy: { agent?: AgentEvent; kind: RequestKind; chars: number; draft: string; reasoning: string } | null;
  error: AppError | null;
  /** 这一轮「AI 问」已经聊了多少个来回。0 表示还没开始。 */
  rounds: number;
  /** 页面不支持时给用户的原因说明。 */
  unsupportedReason: string | null;
};

export type Command =
  | { type: 'attach'; tabId: number | null }
  | { type: 'start'; tabId: number }
  | { type: 'stop'; tabId: number }
  | { type: 'ask'; tabId: number; question: string; search?: boolean; quote?: string | null; quoteId?: string }
  | { type: 'resolveResearch'; tabId: number; sessionId: string; runId: string; mode: 'continue' | 'article' | 'cancel'; text: string }
  | { type: 'setQuote'; tabId: number; text: string }
  | { type: 'clearQuote'; tabId: number; quoteId?: string }
  | { type: 'explore'; tabId: number; bubbleId: string }
  | { type: 'learnStart'; tabId: number; goal: string; search?: boolean }
  | { type: 'learnAnswer'; tabId: number; text: string; choices?: { questionId: string; choiceIds: string[] }[]; search?: boolean }
  | { type: 'learnAssist'; tabId: number; action: 'hint' | 'explain' | 'skip' | 'unknown'; search?: boolean }
  | { type: 'learnEnd'; tabId: number }
  | { type: 'jump'; tabId: number; blockId: string }
  | { type: 'clearSession'; tabId: number }
  | { type: 'clearAllSessions' }
  | { type: 'saveKey'; provider: ProviderId; key: string }
  | { type: 'testKey'; provider: ProviderId; key: string }
  | { type: 'deleteKey'; provider: ProviderId }
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
  | { type: 'listModels'; provider: ProviderId }
  | { type: 'confirmOutbound' };

export type Reply =
  | { ok: true; message?: string; data?: { models?: string[]; imaKbItems?: { id: string; name: string; contentCount: number }[] } }
  | { ok: false; error: AppError };

export type Event =
  | { type: 'agent'; event: AgentEvent }
  | { type: 'state'; state: PanelState }
  | { type: 'progress'; chars: number; draft: string; reasoning: string }
  | { type: 'quote'; tabId: number; sessionId: string; quote: Quote }
  | { type: 'reply'; id: number; reply: Reply };

export type PortRequest = { id: number; command: Command };

/** 后台 → 内容脚本的请求。内容脚本只做与当前 DOM 有关的事。 */
export type ContentRequest =
  | { type: 'extract' }
  | { type: 'fingerprint' }
  | { type: 'watch' }
  | { type: 'jump'; anchor: DomAnchor }
  | { type: 'captureImage'; url: string };

export type ContentReply =
  | { ok: true; data: unknown }
  | { ok: false; error: AppError };
