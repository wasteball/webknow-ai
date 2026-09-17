import { z } from 'zod';

import { HARNESS_RULES, SOURCE_DISCIPLINE, randomBoundary, wrapUntrusted } from './harness';

/**
 * 策略三：引导学习（“AI 问我”）。这是首版唯一允许用户覆盖内容策略的提示词（FR-027）。
 *
 * 覆盖只替换 POLICY 段；HARNESS_RULES、SOURCE_DISCIPLINE 与 LEARN_CONTRACT 由代码拼接，
 * 因此教学覆盖无法解除预算、读取 Key、改变数据接收方或改变输出契约（FR-029）。
 */

export const LEARN_VERSION = '2026-09-18.1';

/** 五类回答（FR-013）。 */
export const VERDICTS = ['correct', 'partial', 'misconception', 'unknown', 'objection'] as const;

export const LearnSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('question'), question: z.string().min(1) }),
  z.object({
    action: z.literal('feedback'),
    verdict: z.enum(VERDICTS),
    feedback: z.string().min(1),
    /** 为 null 表示本轮应进入收束，不再追问。 */
    nextQuestion: z.string().nullable(),
  }),
  z.object({ action: z.literal('hint'), hint: z.string().min(1), question: z.string().min(1) }),
  z.object({
    action: z.literal('explain'),
    explanation: z.string().min(1),
    nextQuestion: z.string().nullable(),
  }),
  z.object({
    action: z.literal('summary'),
    summary: z.string().min(1),
    nextDirections: z.array(z.string()),
  }),
]);

export type LearnOutput = z.infer<typeof LearnSchema>;

export const LEARN_DEFAULT_POLICY = [
  '你在用提问帮助读者检验自己对当前文章的理解。一次只问一个主要问题，然后等待回答。',
  '提问要指向文章的具体内容，并尽量让读者用自己的话解释、识别边界或在未直接展示答案的新情境中应用。',
  '根据回答选择动作：',
  '- 基本正确：指出已经理解的部分，再选择加深、边界、迁移或收束；',
  '- 部分正确：肯定准确部分，指出一个具体缺口，并把下一问缩小；',
  '- 明显误解：说明冲突点，给提示、例子或短讲解后再检验；',
  '- 不知道或请求讲解：不要重复逼问，先提示或直接讲解，再由读者决定是否继续；',
  '- 合理异议：检查作者与你自己的前提和依据，依据不足时明确修正你的判断。',
  '不要把“与 AI 表述一致”“无法反驳”或单次答对当作掌握；不要用连续追问施压。',
  '反馈与收束使用简体中文，只描述本轮实际出现的证据。',
].join('\n');

const LEARN_CONTRACT = [
  '按 mode 返回对应 JSON：',
  '- mode=ask：{"action":"question","question":"..."}',
  '- mode=respond：{"action":"feedback","verdict":"correct|partial|misconception|unknown|objection","feedback":"...","nextQuestion":"..."|null}',
  '- mode=hint：{"action":"hint","hint":"...","question":"..."}（只给提示，不给出答案）',
  '- mode=explain：{"action":"explain","explanation":"...","nextQuestion":"..."|null}',
  '- mode=close：{"action":"summary","summary":"...","nextDirections":["..."]}',
  '收束只覆盖四件事：本轮已展示的理解、经提示后完成的部分、尚未验证或仍有疑问的部分、可选的继续方向。',
  '当剩余提问预算为 0 时使用 mode=close，不得继续提问。',
].join('\n');

/** 覆盖只作用于 POLICY 段；传空或不传则使用内置默认值。 */
export function learnSystem(override?: string): string {
  const policy = override?.trim() ? override.trim() : LEARN_DEFAULT_POLICY;
  return [HARNESS_RULES, SOURCE_DISCIPLINE, policy, LEARN_CONTRACT].join('\n\n');
}

export type LearnMode = 'ask' | 'respond' | 'hint' | 'explain' | 'close';

export function learnMessages(input: {
  mode: LearnMode;
  title: string;
  contextJson: string;
  disclosure: string;
  goal: string;
  used: number;
  budget: number;
  history: { question: string; answer: string; verdict: string; hintUsed: boolean }[];
  currentQuestion: string | null;
  userAnswer?: string;
  /** 上一轮是否已经用过提示：经提示后完成不得记为独立掌握（FR-014）。 */
  hintUsed?: boolean;
  override?: string;
}) {
  const marker = randomBoundary();
  const payload = JSON.stringify({
    mode: input.mode,
    page: { title: input.title },
    disclosure: input.disclosure,
    blocks: JSON.parse(input.contextJson),
    goal: input.goal,
    budget: { used: input.used, total: input.budget, remaining: Math.max(0, input.budget - input.used) },
    history: input.history,
    currentQuestion: input.currentQuestion,
    userAnswer: input.userAnswer,
    hintUsed: input.hintUsed ?? false,
  });
  return [
    { role: 'system' as const, content: learnSystem(input.override) },
    { role: 'user' as const, content: wrapUntrusted(marker, 'SOURCE', payload) },
  ];
}
