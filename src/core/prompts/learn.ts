import { z } from 'zod';

import { HARNESS_RULES, SOURCE_DISCIPLINE, randomBoundary, wrapUntrusted } from './harness';
import type { CurrentRound, QuizChoice } from '../session';

/**
 * 策略三：引导学习（“AI 问我”）。这是首个允许用户覆盖内容策略的提示词板块（FR-027）。
 *
 * 覆盖只替换 POLICY 段；HARNESS_RULES、SOURCE_DISCIPLINE 与 LEARN_CONTRACT 由代码拼接，
 * 因此教学覆盖无法解除预算、读取 Key、改变数据接收方或改变输出契约（FR-029）。
 * 产品化改造 F5：出题方式支持选择题测验轮，评分由程序按答案钥匙判定，模型只写分析。
 */

export const LEARN_VERSION = '2026-09-18.2';

/** 五类回答（FR-013）。 */
export const VERDICTS = ['correct', 'partial', 'misconception', 'unknown', 'objection'] as const;

const ChoiceSchema: z.ZodType<QuizChoice> = z.object({
  id: z.string().min(1).max(16),
  label: z.string().min(1).max(200),
});

export const QuizQuestionSchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(600),
  choices: z.array(ChoiceSchema).min(2).max(4),
  /** 正确选项 id；多选题可以多于一个。程序用它判分，不渲染给用户。 */
  answer: z.array(z.string().min(1).max(16)).min(1).max(4),
  /** 一句话理由：收束或用户要求讲解时可用。 */
  why: z.string().min(1).max(300),
});

const QuizSpecSchema = z.object({ questions: z.array(QuizQuestionSchema).min(1).max(5) });

export const LearnSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('question'), question: z.string().min(1) }),
  z.object({ action: z.literal('quiz'), questions: z.array(QuizQuestionSchema).min(1).max(5) }),
  z.object({
    action: z.literal('feedback'),
    verdict: z.enum(VERDICTS),
    feedback: z.string().min(1),
    /** 为 null 表示本轮应进入收束，不再追问。 */
    nextQuestion: z.string().nullable(),
  }),
  z.object({
    action: z.literal('graded'),
    /** 整轮评析：总体表现、错在哪、接下来补什么。 */
    analysis: z.string().min(1),
    /** 每题一句话判定，按 questionId 对应。 */
    notes: z
      .array(z.object({ questionId: z.string().min(1), note: z.string().min(1).max(300) }))
      .max(5),
    nextQuestion: z.string().nullable(),
    /** 下一轮选择题；为 null 表示下一轮（若有）用开放问题。 */
    nextQuiz: QuizSpecSchema.nullable(),
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
export type QuizOutput = z.infer<typeof QuizQuestionSchema>;

export const LEARN_DEFAULT_POLICY = [
  '你在用提问帮助读者检验自己对当前文章的理解。',
  '每次只提出一个主要问题，然后等待回答：一个问句里只能有一个问号，也不要在一个问句里用逗号、顿号、“另外”“同时”“以及”并列两件事。需要检验第二个点时，留到下一轮再问。',
  '问题要能被读者用几句话回答，不要一次要求复述整段内容或列出全部要点。',
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

const OPEN_ONLY = '出题方式（程序指定）：本轮只能提出开放问题（action=question），不要返回选择题。';
const QUIZ_ONLY = [
  '出题方式（程序指定）：优先提出选择题测验（action=quiz）。',
  '每轮出题 2 到 4 道，题目相互独立，覆盖不同的具体内容点；除非题干本身要求“选出所有正确项”，每题只给一个正确答案。',
  '选项要彼此区分、长度相近，错误选项要像常见误解而不是明显胡说；不要在题干或选项里泄露哪个是对的。',
].join('\n');
const MIXED =
  '出题方式（程序指定）：你可以根据内容选择开放问题（action=question）或选择题测验（action=quiz）：概念辨析、边界判断适合选择题；需要读者自己组织语言表达的内容适合开放问题。选择题每轮 2 到 4 道，除非题干要求多选，每题只给一个正确答案；选项要像常见误解而不是明显胡说。';

export function styleDirective(style: 'mixed' | 'quiz' | 'open'): string {
  if (style === 'quiz') return QUIZ_ONLY;
  if (style === 'open') return OPEN_ONLY;
  return MIXED;
}

const LEARN_CONTRACT = [
  '按 mode 返回对应 JSON：',
  '- mode=ask：{"action":"question","question":"..."}（开放问题；question 里只能有一个问号，且只能问一件事）',
  '- mode=ask 也可以出选择题测验：{"action":"quiz","questions":[{"id":"q1","text":"...","choices":[{"id":"A","label":"..."}],"answer":["A"],"why":"..."}]}（1 到 5 道；每题 2 到 4 个选项；answer 是正确选项的 id，多选题才多于一个；why 是一句话理由；answer 与 why 绝不能出现在题干或选项文字里）',
  '- mode=respond 且当前是开放问题：{"action":"feedback","verdict":"correct|partial|misconception|unknown|objection","feedback":"...","nextQuestion":"..."|null}',
  '- mode=respond 且当前是选择题轮：{"action":"graded","analysis":"...","notes":[{"questionId":"...","note":"..."}],"nextQuestion":null,"nextQuiz":{"questions":[...]}|null}（analysis 给整轮评析：总体表现、错在哪、下一步补什么；notes 对每题给一句话判定；客观对错由程序按答案钥匙判定，你的评析必须与它一致，不得改判；nextQuiz 里的题目结构与 quiz 完全一致，每题都必须含 answer 与 why）',
  '- mode=hint：{"action":"hint","hint":"...","question":"..."}（只给提示，不给出答案）',
  '- mode=explain：{"action":"explain","explanation":"...","nextQuestion":"..."|null}（当前是选择题轮时 nextQuestion 必须为 null，讲完后读者继续作答）',
  '- mode=close：{"action":"summary","summary":"...","nextDirections":["..."]}',
  '收束只覆盖四件事：本轮已展示的理解、经提示后完成的部分、尚未验证或仍有疑问的部分、可选的继续方向。',
  '当剩余提问预算为 0 时使用 mode=close，不得继续提问。',
].join('\n');

/** 覆盖只作用于 POLICY 段；传空或不传则使用内置默认值。 */
export function learnSystem(
  override: string | undefined,
  style: 'mixed' | 'quiz' | 'open' = 'mixed',
): string {
  const policy = override?.trim() ? override.trim() : LEARN_DEFAULT_POLICY;
  return [HARNESS_RULES, SOURCE_DISCIPLINE, policy, styleDirective(style), LEARN_CONTRACT].join('\n\n');
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
  /** 当前轮次：开放问题或选择题（含答案钥匙，程序判定用）。 */
  current: CurrentRound | null;
  /** 开放问题的用户回答文本。 */
  userAnswer?: string;
  /** 当前轮为选择题时的用户作答。 */
  userAnswers?: { questionId: string; choiceIds: string[] }[];
  /** 上一轮是否已经用过提示：经提示后完成不得记为独立掌握（FR-014）。 */
  hintUsed?: boolean;
  override?: string;
  style?: 'mixed' | 'quiz' | 'open';
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
    // 当前是选择题轮时把答案钥匙一并发给模型：程序按钥匙判分，模型据此写评析。
    currentRound:
      input.current === null
        ? null
        : input.current.kind === 'open'
          ? { kind: 'open', question: input.current.question }
          : { kind: 'quiz', questions: input.current.questions, answerKey: input.current.answerKey },
    userAnswers: input.userAnswers ?? null,
    userAnswer: input.userAnswer,
    hintUsed: input.hintUsed ?? false,
  });
  return [
    { role: 'system' as const, content: learnSystem(input.override, input.style) },
    { role: 'user' as const, content: wrapUntrusted(marker, 'SOURCE', payload) },
  ];
}
