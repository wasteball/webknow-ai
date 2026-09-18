/**
 * 运行参数集中维护（PRD 第 9 节）。
 *
 * 这些是“暂定默认，待验证”：只有 A0/A1 的真实基准和样例证据支持时才冻结数值。
 * 首版不为它们提供用户界面（PRD FR-027）。
 */
export const LIMITS = {
  /** 正文处理上限：超出即阻断并说明范围，绝不静默截断后声称覆盖全文（FR-018）。 */
  maxContextChars: 45_000,
  maxBlocks: 400,
  /** 低于此值判为“没有可用的连续正文”（FR-002/FR-006）。 */
  minArticleChars: 80,
  minBlocks: 3,

  /** 首屏短摘要与探索气泡（PRD 第 9 节：约 3 个，内容不足可少给，不凑数）。 */
  maxBubbles: 3,
  summaryMaxChars: 240,
  bubbleQuestionMaxChars: 60,

  /** 单轮输入输出上限。 */
  maxQuestionChars: 500,
  maxLearningAnswerChars: 1_000,
  maxOutputTokens: 1_200,
  /** 教学提示词覆盖的保存上限（FR-028 校验的一部分）。 */
  maxTeachingPromptChars: 8_000,

  /** 引导学习预算：到限先收束，由用户明确决定是否续开（FR-012/FR-039）。 */
  learningBudget: 5,
  /** 用户可在设置里调整的预算范围（产品化改造 F2）；硬上限仍由这里保护。 */
  learningBudgetMin: 1,
  learningBudgetMax: 10,
  /** 同一标签页会话保留的问答轮数上限（FR-039 硬上限）。 */
  maxChatTurns: 20,
  /** 发送给模型的历史轮数（多退少补的上下文窗口，不是留存上限）。 */
  maxHistoryTurns: 6,

  /** 超时、重试与并发：有限、可见、不允许形成费用失控（FR-035/FR-039）。 */
  requestTimeoutMs: 90_000,
  maxRetries: 1,
  retryBackoffMs: 1_200,
  /** 每个标签页同时只允许一个在途请求。 */
  maxConcurrentPerTab: 1,
} as const;

export type Limits = typeof LIMITS;

/** 摘要长度偏好（产品化改造 F2）：设置里选档，程序换算成字数写进策略提示词。 */
export type SummaryLength = 'short' | 'medium' | 'long';

export const SUMMARY_LENGTH_CHARS: Record<SummaryLength, number> = {
  short: 120,
  medium: 240,
  long: 400,
};
