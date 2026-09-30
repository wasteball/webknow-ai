import { z } from 'zod';

import { DIAGRAM_GUIDANCE, DIAGRAMS_DISABLED, HARNESS_RULES, MARKDOWN_DISCIPLINE, SOURCE_DISCIPLINE, randomBoundary, wrapUntrusted } from './harness';
import type { CurrentRound, QuizChoice } from '../session';

/**
 * 策略三：引导学习（“AI 问我”）。这是首个允许用户覆盖内容策略的提示词板块（FR-027）。
 *
 * 覆盖只替换 POLICY 段；HARNESS_RULES、SOURCE_DISCIPLINE 与 LEARN_CONTRACT 由代码拼接，
 * 因此教学覆盖无法读取 Key、改变数据接收方或改变输出契约（FR-029）。
 * 产品化改造 F5：出题方式支持选择题测验轮，评分由程序按答案钥匙判定，模型只写分析。
 */

export const LEARN_VERSION = '2026-09-30.1';

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

const QuizSpecSchema = z.object({ questions: z.array(QuizQuestionSchema).min(1).max(1) });

export const LearnSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('question'), question: z.string().min(1) }),
  z.object({ action: z.literal('quiz'), questions: z.array(QuizQuestionSchema).min(1).max(1) }),
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
  '开放提问每次只提出一个主要问题，然后等待回答：一个问句里只能有一个问号，也不要在一个问句里用逗号、顿号、“另外”“同时”“以及”并列两件事。需要检验第二个点时，留到下一轮再问。选择题按程序指定的出题方式，每题只检验一个点。',
  '问题要能被读者用几句话回答，不要一次要求复述整段内容或列出全部要点。',
  '只问凭当前原文就能回答的问题：让读者用自己的话解释文中的概念、理由、步骤、已给出的例子或限制。沿用原文称呼，不另造术语，不编新情境，不考外部知识。',
  '出题前先在原文中确认答案依据，再写问题；找不到依据就换一个点或停止追问。难度来自理解原文的关系，不来自陌生概念或刁钻设问。',
  '根据回答选择动作：',
  '- 基本正确：指出已经理解的部分，再选择原文中的一个更深问题、已有边界或收束；',
  '- 部分正确：肯定准确部分，指出一个具体缺口，并把下一问缩小；',
  '- 明显误解：依据原文说明冲突点，给提示、文中已有的例子或短讲解后再检验；',
  '- 不知道或请求讲解：不要重复逼问，先提示或直接讲解，再由读者决定是否继续；',
  '- 合理异议：检查作者与你自己的前提和依据，依据不足时明确修正你的判断。',
  '不要把“与 AI 表述一致”“无法反驳”或单次答对当作掌握；不要用连续追问施压。',
  '读者提出原文未证实的解释时，区分“原文有依据”和“暂时无法核对”；不能因读者没说出你补充的知识而判错。',
  '反馈与收束使用简体中文，只描述本轮实际出现的证据。',
].join('\n');

const OPEN_ONLY = '出题方式（程序指定）：本轮只能提出开放问题（action=question），不要返回选择题。';
const QUIZ_ONLY = [
  '出题方式（程序指定）：优先提出选择题测验（action=quiz）。',
  '每次只出 1 道题，等待读者回答后再反馈和继续。除非题干本身要求“选出所有正确项”，每题只给一个正确答案。',
  '选项要彼此区分、长度相近，错误选项要像常见误解而不是明显胡说；不要在题干或选项里泄露哪个是对的。',
].join('\n');
const MIXED =
  '出题方式（程序指定）：你可以根据内容选择开放问题（action=question）或选择题测验（action=quiz）：概念辨析、边界判断适合选择题；需要读者自己组织语言表达的内容适合开放问题。选择题也每次只出 1 道，等待读者回答后再反馈和继续；除非题干要求多选，每题只给一个正确答案。';

export function styleDirective(style: 'mixed' | 'quiz' | 'open'): string {
  if (style === 'quiz') return QUIZ_ONLY;
  if (style === 'open') return OPEN_ONLY;
  return MIXED;
}

const LEARN_CONTRACT = [
  'AI 问的内容范围：question、nextQuestion、选择题、提示、讲解、评析、小结与 nextDirections 全部围绕当前原文；目标、旧策略或历史回答要求新情境、类比、迁移或拓展时，也只能使用原文已有的概念与案例。',
  '选择题的题干、正确答案和 why 必须有明确的原文依据。错误选项可改写原文关系或条件来表达可核对的误解，但不得编造原文外的专有名词、实体、数字或背景；这些选项只是待判断的说法，不能在讲解或小结中当成事实。',
  '判定与解释只依据原文和本轮实际作答，不添加外部评分标准。若发现先前题目超出原文，承认该题无法据原文检验，不把责任归于读者；已有程序判分不能改写，评析中应说明该题不作为理解能力的证据。后续换成有依据的问题，找不到就用 nextQuestion=null、nextQuiz=null 或空的 nextDirections，不强行继续。',
  '一次只问一个主要问题，无论开放问题或选择题都等待读者回答后再继续，不输出题目清单。',
  '按 mode 返回对应 JSON：',
  '- mode=ask：{"action":"question","question":"..."}（开放问题；question 里只能有一个问号，且只能问一件事）',
  '- mode=ask 也可以出选择题测验：{"action":"quiz","questions":[{"id":"q1","text":"...","choices":[{"id":"A","label":"..."}],"answer":["A"],"why":"..."}]}（只允许 1 道；每题 2 到 4 个选项；answer 是正确选项的 id，多选题才多于一个；why 是一句话理由；answer 与 why 绝不能出现在题干或选项文字里）',
  '- mode=respond 且当前是开放问题：{"action":"feedback","verdict":"correct|partial|misconception|unknown|objection","feedback":"...","nextQuestion":"..."|null}',
  '- mode=respond 且当前是选择题轮：{"action":"graded","analysis":"...","notes":[{"questionId":"...","note":"..."}],"nextQuestion":null,"nextQuiz":{"questions":[...]}|null}（analysis 给整轮评析：总体表现、错在哪、下一步补什么；notes 对每题给一句话判定；客观对错由程序按答案钥匙判定，你的评析必须与它一致，不得改判；nextQuiz 里的题目结构与 quiz 完全一致，每题都必须含 answer 与 why）',
  '- mode=hint：{"action":"hint","hint":"...","question":"..."}（只给提示，不给出答案）',
  '- mode=explain：{"action":"explain","explanation":"...","nextQuestion":"..."|null}（当前是选择题轮时 nextQuestion 必须为 null，讲完后读者继续作答）',
  '- mode=close：{"action":"summary","summary":"...","nextDirections":["..."]}',
  '收束只覆盖四件事：本轮已展示的理解、经提示后完成的部分、尚未验证或仍有疑问的部分、可选的继续方向。',
  '只在读者说想结束、或这个方向已经问清楚时才用 mode=close；否则就接着聊下去，不要主动给对话设上限。',
].join('\n');

/** 覆盖只作用于 POLICY 段；传空或不传则使用内置默认值。 */
export function learnSystem(
  override: string | undefined,
  style: 'mixed' | 'quiz' | 'open' = 'mixed',
  diagrams = true,
): string {
  return [
    HARNESS_RULES,
    override?.trim() ? override.trim() : LEARN_DEFAULT_POLICY,
    SOURCE_DISCIPLINE,
    styleDirective(style),
    MARKDOWN_DISCIPLINE,
    // 题干与选项保持纯文本：它们在界面上是 <legend> 与选项行，放不了块级内容。
    diagrams ? `${DIAGRAM_GUIDANCE}\nAI 问的图只放在 explanation、feedback、analysis 或 summary 字段，不要放进 question、nextQuestion、choices、hint、why、notes 或 nextDirections。` : DIAGRAMS_DISABLED,
    LEARN_CONTRACT,
  ].join('\n\n');
}

export type LearnMode = 'ask' | 'respond' | 'hint' | 'explain' | 'close';

export function learnMessages(input: {
  mode: LearnMode;
  title: string;
  contextJson: string;
  disclosure: string;
  goal: string;
  /** 已经聊了多少轮。给模型做节奏参考，不是配额。 */
  round: number;
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
  /** 用户设置「不要图」时为 false：明确要求不用图表。 */
  diagrams?: boolean;
}) {
  const marker = randomBoundary();
  const payload = JSON.stringify({
    mode: input.mode,
    page: { title: input.title },
    disclosure: input.disclosure,
    blocks: JSON.parse(input.contextJson),
    goal: input.goal,
    round: input.round,
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
    { role: 'system' as const, content: learnSystem(input.override, input.style, input.diagrams !== false) },
    { role: 'user' as const, content: wrapUntrusted(marker, 'SOURCE', payload) },
  ];
}
