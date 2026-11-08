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
  /** 低于此值判为“没有可用的连续正文”（FR-002/FR-006）。短讯、短评也要能读。 */
  minArticleChars: 40,
  minBlocks: 1,

  /** 首屏短摘要与探索气泡（PRD 第 9 节：约 3 个，内容不足可少给，不凑数）。 */
  maxBubbles: 3,
  summaryMaxChars: 240,
  bubbleQuestionMaxChars: 60,

  /** 单轮输入输出上限。 */
  maxQuestionChars: 500,
  maxLearningAnswerChars: 1_000,
  /** 二期由 1200 提到 3000：长回答“说到一半断了”的根因是这个上限太小。 */
  maxOutputTokens: 3_000,
  /**
   * 打开思考后的输出上限。思考文本和最终 JSON 共用这一个数，仍远小于文档里的 64K/128K。
   * 暂定，待真实请求量过再冻；超出后仍按长度截断整段作废。
   */
  maxOutputTokensThinking: 8_000,
  /** 教学提示词覆盖的保存上限（FR-028 校验的一部分）。 */
  maxTeachingPromptChars: 8_000,

  /**
   * 一次「AI 问」里最多连着问多少轮：只是防死循环的护栏。每轮都要等用户先回答，
   * 真实对话碰不到它（二期起由 30 放宽到 200；对话本身不再按轮数截断）。
   */
  learnRoundsCap: 200,

  /**
   * 超时（二期）：按“多久没有新进展”判断，不按整段总时长——长回答一直在写就不打断。
   * 硬上限只防费用失控。requestTimeoutMs 仍是联网研究各步骤的单步上限。
   */
  idleTimeoutMs: 45_000,
  hardTimeoutMs: 300_000,
  requestTimeoutMs: 90_000,
  maxRetries: 1,
  retryBackoffMs: 1_200,
  /** 每个标签页同时只允许一个在途请求。 */
  maxConcurrentPerTab: 1,

  /** 联网搜索（F3）：单次注入提示词的结果数上限。 */
  searchResultsCount: 5,
  searchTimeoutMs: 15_000,

  /** 一页里拿去读的内容图上限。多出来的只披露，不静默当成读过。 */
  maxImages: 6,
  /** 送去读图前，长边压到这个像素。 */
  maxImageEdge: 1024,
  /** 单张图的读图超时。到点就跳过这张，不拖垮整篇。 */
  visionTimeoutMs: 25_000,
} as const;

export type Limits = typeof LIMITS;

/** 摘要长度偏好（产品化改造 F2）：设置里选档，程序换算成字数写进策略提示词。 */
export type SummaryLength = 'short' | 'medium' | 'long';

export const SUMMARY_LENGTH_CHARS: Record<SummaryLength, number> = {
  short: 120,
  medium: 240,
  long: 400,
};
