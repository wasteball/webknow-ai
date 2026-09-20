import type { EvidenceBlock } from './blocks';
import { appError, type AppError } from './errors';
import { LIMITS } from './limits';
import { AnswerSchema } from './prompts/answer';
import { BUBBLE_KINDS, GuideSchema } from './prompts/guide';
import { LearnSchema, type LearnMode } from './prompts/learn';
import type { AnswerSource, Bubble, BubbleKind, Citation, QuizKey, QuizQuestion, Verdict } from './session';

/**
 * 程序侧校验：模型输出只是候选，写入会话前必须通过结构与引用校验（FR-016/FR-029）。
 * 这里不做“猜测性修补”——不确定的内容宁可降级或丢弃，也不假装可信。
 */

export type Clean<T> = { ok: true; value: T } | { ok: false; error: AppError };

const BAD_OUTPUT_RUNAWAY = 4_000;

/** 一次一问：开放问题 / 下一问里最多一个问号。两个问号就是两件事。 */
export function isSingleQuestion(text: string): boolean {
  return (text.match(/[？?]/g) ?? []).length <= 1;
}

function badOutput(what: string): AppError {
  return appError('BAD_OUTPUT', `这次生成的内容格式不对，没有采用。可以再试一次。`, true);
}

export function cleanGuide(
  parsed: unknown,
  maxBubbles: number = LIMITS.maxBubbles,
): Clean<{ summary: string; bubbles: Bubble[] }> {
  const result = GuideSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: badOutput('首屏结果') };

  const summary = result.data.summary.trim();
  if (!summary || summary.length > BAD_OUTPUT_RUNAWAY) {
    return { ok: false, error: badOutput('摘要') };
  }

  const cap = Math.min(Math.max(0, Math.round(maxBubbles)), LIMITS.maxBubbles);
  return { ok: true, value: { summary, bubbles: takeBubbles(result.data.bubbles, cap, 'bub') } };
}

function takeBubbles(
  raw: { question: string; kind?: string }[],
  cap: number,
  prefix: string,
): Bubble[] {
  const seen = new Set<string>();
  const bubbles: Bubble[] = [];
  for (const [index, item] of raw.entries()) {
    const question = item.question.trim();
    if (!question || question.length > LIMITS.bubbleQuestionMaxChars * 4) continue;
    if (!isSingleQuestion(question)) continue;
    const key = question.replace(/\s+/g, '').replace(/[？?。.!！]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = (BUBBLE_KINDS as readonly string[]).includes(item.kind ?? '')
      ? (item.kind as BubbleKind)
      : 'concept';
    bubbles.push({ id: `${prefix}_${index}`, question, kind });
    if (bubbles.length >= cap) break;
  }
  return bubbles;
}

export function cleanAnswer(
  parsed: unknown,
  blocks: EvidenceBlock[],
  webResults: { url: string; title: string; snippet: string }[] = [],
): Clean<{
  answer: string;
  source: AnswerSource;
  citations: Citation[];
  unanswered: string[];
  references: string[];
  followUps: Bubble[];
}> {
  const result = AnswerSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: badOutput('回答') };

  const answer = result.data.answer.trim();
  if (!answer || answer.length > BAD_OUTPUT_RUNAWAY * 2) {
    return { ok: false, error: badOutput('回答') };
  }

  const known = new Set(blocks.map((block) => block.id));
  const citations: Citation[] = [];
  for (const blockId of new Set(result.data.citations)) {
    if (known.has(blockId)) citations.push({ blockId });
  }

  const unanswered = result.data.unanswered.map((item) => item.trim()).filter(Boolean);

  // references 只能是程序注入的网络结果 URL 原样复制；其余一律丢弃（F3）。
  const knownUrls = new Set(webResults.map((item) => item.url));
  const references = [...new Set(result.data.references ?? [])]
    .map((url) => url.trim())
    .filter((url) => knownUrls.has(url))
    .slice(0, 5);

  let source: AnswerSource = result.data.source;
  if (source === 'original' && citations.length === 0) {
    // 原文依据必须有本地块。有网络结果也不能让这条规则失效——否则会把网上的话标成作者原话。
    if (references.length > 0) {
      source = 'extended';
    } else {
      source = 'unknown';
      unanswered.push('这条回答未能在当前正文中找到可直接核对的依据，因此未标为原文依据。');
    }
  }

  const followUps = takeBubbles(result.data.followUps ?? [], LIMITS.maxBubbles, 'next');

  return { ok: true, value: { answer, source, citations, unanswered, references, followUps } };
}

export type LearnResult =
  | { action: 'question'; question: string }
  | { action: 'quiz'; questions: QuizQuestion[]; answerKey: QuizKey[] }
  | {
      action: 'feedback';
      verdict: Verdict;
      feedback: string;
      nextQuestion: string | null;
    }
  | {
      action: 'graded';
      analysis: string;
      notes: { questionId: string; note: string }[];
      nextQuestion: string | null;
      nextQuiz: { questions: QuizQuestion[]; answerKey: QuizKey[] } | null;
    }
  | { action: 'hint'; hint: string; question: string }
  | { action: 'explain'; explanation: string; nextQuestion: string | null }
  | { action: 'summary'; summary: string; nextDirections: string[] };

/**
 * mode → 允许的动作。模型返回与请求模式不符时视为无效输出，不发散解释。
 *
 * respond 允许三种：开放问题给 feedback；选择题轮给 graded（客观对错由程序按答案钥匙判定，
 * 模型只写评析）；读者说“不知道”或要求讲解时返回 explain（FR-013 要求先讲解而不是重复逼问）。
 */
const EXPECTED: Record<LearnMode, readonly LearnResult['action'][]> = {
  ask: ['question', 'quiz'],
  respond: ['feedback', 'explain', 'graded'],
  hint: ['hint'],
  explain: ['explain'],
  close: ['summary'],
};

/** 把模型返回的选择题规格整理成会话数据：题目（无答案）+ 答案钥匙。 */
function cleanQuizQuestions(
  raw: { id: string; text: string; choices: { id: string; label: string }[]; answer: string[]; why: string }[],
): { questions: QuizQuestion[]; answerKey: QuizKey[] } | null {
  const questions: QuizQuestion[] = [];
  const answerKey: QuizKey[] = [];
  const seenQuestionIds = new Set<string>();
  for (const item of raw) {
    const id = item.id.trim();
    const text = item.text.trim();
    if (!id || !text || seenQuestionIds.has(id)) return null;
    const choices = item.choices
      .map((choice) => ({ id: choice.id.trim(), label: choice.label.trim() }))
      .filter((choice) => choice.id && choice.label);
    const choiceIds = new Set(choices.map((choice) => choice.id));
    if (choices.length < 2 || choiceIds.size !== choices.length) return null;
    const answer = [...new Set(item.answer.map((value) => value.trim()))].filter((value) => value);
    if (!answer.length || !answer.every((value) => choiceIds.has(value))) return null;
    const why = item.why.trim();
    if (!why) return null;
    seenQuestionIds.add(id);
    questions.push({ id, text, choices, multi: answer.length > 1 });
    answerKey.push({ questionId: id, answer, why });
  }
  return questions.length ? { questions, answerKey } : null;
}

export function cleanLearn(
  parsed: unknown,
  mode: LearnMode,
  currentKind?: 'open' | 'quiz',
): Clean<LearnResult> {
  const result = LearnSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: badOutput('学习反馈') };
  const data = result.data;
  if (!EXPECTED[mode].includes(data.action)) return { ok: false, error: badOutput('学习反馈') };

  // 动作必须与当前轮次类型匹配：选择题轮用 graded，开放问题用 feedback。
  if (mode === 'respond') {
    if (data.action === 'graded' && currentKind !== 'quiz') return { ok: false, error: badOutput('学习反馈') };
    if (data.action === 'feedback' && currentKind !== 'open') return { ok: false, error: badOutput('学习反馈') };
  }

  switch (data.action) {
    case 'question': {
      const question = data.question.trim();
      if (!isSingleQuestion(question)) return { ok: false, error: badOutput('学习反馈') };
      return { ok: true, value: { action: 'question', question } };
    }
    case 'quiz': {
      const cleaned = cleanQuizQuestions(data.questions);
      if (!cleaned) return { ok: false, error: badOutput('学习反馈') };
      if (cleaned.questions.some((question) => !isSingleQuestion(question.text))) {
        return { ok: false, error: badOutput('学习反馈') };
      }
      return { ok: true, value: { action: 'quiz', ...cleaned } };
    }
    case 'feedback': {
      const next = data.nextQuestion?.trim() || null;
      return {
        ok: true,
        value: {
          action: 'feedback',
          verdict: data.verdict,
          feedback: data.feedback.trim(),
          nextQuestion: next && isSingleQuestion(next) ? next : null,
        },
      };
    }
    case 'graded': {
      // nextQuiz 缺答案钥匙、或下一问一次问了两件事，只降级丢掉下一轮，本轮批改仍可用。
      const rawNextQuiz = data.nextQuiz ? cleanQuizQuestions(data.nextQuiz.questions) : null;
      const nextQuiz =
        rawNextQuiz && rawNextQuiz.questions.every((question) => isSingleQuestion(question.text))
          ? rawNextQuiz
          : null;
      const next = data.nextQuestion?.trim() || null;
      return {
        ok: true,
        value: {
          action: 'graded',
          analysis: data.analysis.trim(),
          notes: data.notes
            .map((note) => ({ questionId: note.questionId.trim(), note: note.note.trim() }))
            .filter((note) => note.questionId && note.note),
          nextQuestion: next && isSingleQuestion(next) ? next : null,
          nextQuiz,
        },
      };
    }
    case 'hint': {
      const question = data.question.trim();
      if (!isSingleQuestion(question)) return { ok: false, error: badOutput('学习反馈') };
      return {
        ok: true,
        value: { action: 'hint', hint: data.hint.trim(), question },
      };
    }
    case 'explain': {
      const next = data.nextQuestion?.trim() || null;
      return {
        ok: true,
        value: {
          action: 'explain',
          explanation: data.explanation.trim(),
          nextQuestion: next && isSingleQuestion(next) ? next : null,
        },
      };
    }
    case 'summary':
      return {
        ok: true,
        value: {
          action: 'summary',
          summary: data.summary.trim(),
          nextDirections: data.nextDirections.map((item) => item.trim()).filter(Boolean).slice(0, 3),
        },
      };
  }
}

/** 教学提示词覆盖的保存校验（FR-028）：无效内容不替换上一次有效配置。 */
export function validateTeachingPrompt(text: string): Clean<string> {
  const value = text.trim();
  if (!value) {
    return { ok: false, error: appError('BAD_OUTPUT', '教学提示词不能是空的。', false) };
  }
  if (value.length > LIMITS.maxTeachingPromptChars) {
    return {
      ok: false,
      error: appError(
        'BAD_OUTPUT',
        `教学提示词太长了（超过 ${LIMITS.maxTeachingPromptChars} 字），已经保留你上一次保存的内容。`,
        false,
      ),
    };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return { ok: false, error: appError('BAD_OUTPUT', '教学提示词里有一些看不见的特殊字符，没法保存。', false) };
  }
  return { ok: true, value };
}
