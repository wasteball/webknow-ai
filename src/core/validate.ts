import type { EvidenceBlock } from './blocks';
import { appError, type AppError } from './errors';
import { LIMITS } from './limits';
import { AnswerSchema } from './prompts/answer';
import { BUBBLE_KINDS, GuideSchema } from './prompts/guide';
import { LearnSchema, type LearnMode } from './prompts/learn';
import type { AnswerSource, Bubble, BubbleKind, Citation, LearnSupplement, QuestionTarget, QuizKey, QuizQuestion, Verdict } from './session';

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 读者看得见的句子里去掉内部块编号。
 * 核对入口是「看看原文」，不是 b_5 这种程序标记。
 */
export function omitBlockIds(text: string, ids: readonly string[]): string {
  const unique = [...new Set(ids)].filter(Boolean).sort((left, right) => right.length - left.length);
  if (!unique.length) return text.trim();
  const id = unique.map(escapeRegExp).join('|');
  const mention = new RegExp(
    `(?:[（(\\[【]\\s*)?(?:(?:根据|见|参见|依据|来自|出自|引用)\\s*)?(?:在\\s*)?(?:正文块|块)?\\s*(?<![A-Za-z0-9_])(?:${id})(?![A-Za-z0-9_])(?:\\s*[里中处])?\\s*(?:[）)\\]】])?`,
    'g',
  );
  // 图表/代码里的缩进与节点名是语法，不能拿清理读者句子的规则去改它。
  const fence = /(^[ \t]*```mermaid[ \t]+[^`\n]+[ \t]+```[ \t]*(?=\n|$)|^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*(?=\n|$))/gim;
  return text
    .split(fence)
    .map((part, index) => index % 2 === 1 ? part : cleanProse(part, mention))
    .join('')
    .trim();
}

function cleanProse(text: string, mention: RegExp): string {
  return text
    .replace(mention, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+([，。；、：,])/g, '$1')
    .replace(/([。！？])[，、, \t]+/g, '$1')
    .replace(/[（(\\[【]\s*[）)\\]】]/g, '')
    .replace(/^[，、：, \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

function badOutput(what: string): AppError {
  return appError('BAD_OUTPUT', `这次生成的内容格式不对，没有采用。可以再试一次。`, true);
}

export function cleanGuide(
  parsed: unknown,
  maxBubbles: number = LIMITS.maxBubbles,
  blockIds: readonly string[] = [],
): Clean<{ summary: string; bubbles: Bubble[] }> {
  const result = GuideSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: badOutput('首屏结果') };

  const summary = omitBlockIds(result.data.summary.trim(), blockIds);
  if (!summary || summary.length > BAD_OUTPUT_RUNAWAY) {
    return { ok: false, error: badOutput('摘要') };
  }

  const cap = Math.min(Math.max(0, Math.round(maxBubbles)), LIMITS.maxBubbles);
  return { ok: true, value: { summary, bubbles: takeBubbles(result.data.bubbles, cap, 'bub', blockIds) } };
}

function takeBubbles(
  raw: { question: string; kind?: string }[],
  cap: number,
  prefix: string,
  blockIds: readonly string[] = [],
): Bubble[] {
  const seen = new Set<string>();
  const bubbles: Bubble[] = [];
  for (const [index, item] of raw.entries()) {
    const question = omitBlockIds(item.question.trim(), blockIds);
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

  const knownIds = blocks.map((block) => block.id);
  const answer = omitBlockIds(result.data.answer.trim(), knownIds);
  if (!answer || answer.length > BAD_OUTPUT_RUNAWAY * 2) {
    return { ok: false, error: badOutput('回答') };
  }

  const citations = articleCitations(result.data.citations, blocks);

  const unanswered = result.data.unanswered
    .map((item) => omitBlockIds(item.trim(), knownIds))
    .filter(Boolean);

  // references 只能是程序注入的网络结果 URL 原样复制；其余一律丢弃（F3）。
  const knownUrls = new Set(webResults.map((item) => item.url));
  const references = [...new Set(result.data.references ?? [])]
    .map((url) => url.trim())
    .filter((url) => knownUrls.has(url))
    .slice(0, 5);

  let source: AnswerSource = result.data.source;
  const imageIds = new Set(blocks.filter((block) => block.role === 'image').map((block) => block.id));
  if (source === 'original' && citations.length > 0 && citations.every((item) => imageIds.has(item.blockId))) {
    source = 'supplement';
  }
  if (source === 'original' && citations.length === 0) {
    // 原文依据必须有本地块。有网络结果也不能让这条规则失效——否则会把网上的话标成作者原话。
    if (references.length > 0) {
      source = 'extended';
    } else {
      source = 'unknown';
      unanswered.push('这条回答未能在当前正文中找到可直接核对的依据，因此未标为原文依据。');
    }
  }

  const followUps = takeBubbles(result.data.followUps ?? [], LIMITS.maxBubbles, 'next', knownIds);

  return { ok: true, value: { answer, source, citations, unanswered, references, followUps } };
}

function articleCitations(ids: string[], blocks: EvidenceBlock[]): Citation[] {
  const known = new Set(blocks.map(block => block.id));
  return [...new Set(ids)].filter(id => known.has(id)).map(blockId => ({ blockId }));
}

/** Research must reject an invalid citation before legacy cleaning can discard it. */
export function validateArticleCitations(ids: string[], blocks: EvidenceBlock[], source: AnswerSource): Clean<Citation[]> {
  const citations = articleCitations(ids, blocks);
  if (citations.length !== new Set(ids).size || (source === 'original' &&
    (!citations.length || citations.some(citation => blocks.find(block => block.id === citation.blockId)!.role === 'image')))) {
    return { ok: false, error: badOutput('文章引用') };
  }
  return { ok: true, value: citations };
}

export type LearnResult =
  | { action: 'question'; question: string; target?: QuestionTarget }
  | { action: 'quiz'; questions: QuizQuestion[]; answerKey: QuizKey[] }
  | {
      action: 'feedback'; verdict: Verdict; feedback: string; supplement?: LearnSupplement;
      nextQuestion: string | null; nextQuestionTarget?: QuestionTarget;
    }
  | {
      action: 'graded'; analysis: string; supplement?: LearnSupplement;
      notes: { questionId: string; note: string }[]; nextQuestion: string | null;
      nextQuestionTarget?: QuestionTarget; nextQuiz: { questions: QuizQuestion[]; answerKey: QuizKey[] } | null;
    }
  | { action: 'hint'; hint: string; question: string }
  | { action: 'explain'; explanation: string; supplement?: LearnSupplement; nextQuestion: string | null; nextQuestionTarget?: QuestionTarget }
  | { action: 'summary'; summary: string; supplement?: LearnSupplement; coveredTargets?: string[]; uncoveredTargets?: string[]; nextDirections: string[] };

const EXPECTED: Record<LearnMode, readonly LearnResult['action'][]> = {
  ask: ['question', 'quiz'], respond: ['feedback', 'explain', 'graded'], hint: ['hint'], explain: ['explain'], close: ['summary'],
};

function cleanTarget(raw: QuestionTarget | undefined, blockIds: readonly string[]): QuestionTarget | null | undefined {
  if (!raw) return undefined;
  const known = new Set(blockIds);
  const ids = [...new Set(raw.blockIds.map(id => id.trim()))];
  const invalid = (value: string) => /[\u0000-\u001f\u007f]/.test(value);
  if (!ids.length || ids.length > 8 || ids.some(id => !known.has(id))) return null;
  const focus = raw.focus.trim();
  const list = (values: string[] | undefined) => values?.map(value => value.trim()).filter(Boolean).slice(0, 4);
  const conditions = list(raw.conditions);
  const misconceptions = list(raw.misconceptions);
  if (!focus || focus.length > 120 || invalid(focus) || conditions?.some(value => value.length > 200 || invalid(value)) || misconceptions?.some(value => value.length > 200 || invalid(value))) return null;
  return {
    blockIds: ids,
    focus,
    ...(conditions?.length ? { conditions } : {}),
    ...(misconceptions?.length ? { misconceptions } : {}),
  };
}

function cleanSupplement(raw: { text: string; source: 'stable' | 'network' | 'unverified' } | undefined): LearnSupplement | null | undefined {
  if (!raw) return undefined;
  const text = raw.text.trim();
  if (!text || text.length > 800 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return { text, source: raw.source };
}

function cleanTextList(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return values.map(value => value.trim()).filter(Boolean).slice(0, 8);
}

/** 把模型返回的选择题规格整理成会话数据：题目（无答案）+ 答案钥匙。 */
function cleanQuizQuestions(
  raw: { id: string; text: string; choices: { id: string; label: string }[]; answer: string[]; why: string; target?: QuestionTarget }[],
  blockIds: readonly string[] = [],
): { questions: QuizQuestion[]; answerKey: QuizKey[] } | null {
  const questions: QuizQuestion[] = [];
  const answerKey: QuizKey[] = [];
  const seenQuestionIds = new Set<string>();
  for (const item of raw) {
    const id = item.id.trim();
    const text = omitBlockIds(item.text.trim(), blockIds);
    if (!id || !text || seenQuestionIds.has(id)) return null;
    const choices = item.choices
      .map((choice) => ({ id: choice.id.trim(), label: omitBlockIds(choice.label.trim(), blockIds) }))
      .filter((choice) => choice.id && choice.label);
    const choiceIds = new Set(choices.map((choice) => choice.id));
    if (choices.length < 2 || choiceIds.size !== choices.length) return null;
    const answer = [...new Set(item.answer.map((value) => value.trim()))].filter((value) => value);
    if (!answer.length || !answer.every((value) => choiceIds.has(value))) return null;
    const why = omitBlockIds(item.why.trim(), blockIds);
    const target = cleanTarget(item.target, blockIds);
    if (!why || target === null) return null;
    seenQuestionIds.add(id);
    questions.push({ id, text, choices, multi: answer.length > 1, ...(target ? { target } : {}) });
    answerKey.push({ questionId: id, answer, why });
  }
  return questions.length ? { questions, answerKey } : null;
}

export function cleanLearn(parsed: unknown, mode: LearnMode, currentKind?: 'open' | 'quiz', blockIds: readonly string[] = []): Clean<LearnResult> {
  const result = LearnSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: badOutput('学习反馈') };
  const data = result.data;
  if (!EXPECTED[mode].includes(data.action)) return { ok: false, error: badOutput('学习反馈') };
  const show = (value: string) => omitBlockIds(value, blockIds);
  if (mode === 'respond') {
    if (data.action === 'graded' && currentKind !== 'quiz') return { ok: false, error: badOutput('学习反馈') };
    if (data.action === 'feedback' && currentKind !== 'open') return { ok: false, error: badOutput('学习反馈') };
  }

  switch (data.action) {
    case 'question': {
      const question = show(data.question.trim());
      const target = cleanTarget(data.target, blockIds);
      if (!question || !isSingleQuestion(question) || target === null) return { ok: false, error: badOutput('学习反馈') };
      return { ok: true, value: { action: 'question', question, ...(target ? { target } : {}) } };
    }
    case 'quiz': {
      const cleaned = cleanQuizQuestions(data.questions, blockIds);
      if (!cleaned || cleaned.questions.some(question => !isSingleQuestion(question.text))) return { ok: false, error: badOutput('学习反馈') };
      return { ok: true, value: { action: 'quiz', ...cleaned } };
    }
    case 'feedback': {
      const feedback = show(data.feedback.trim());
      const next = show(data.nextQuestion?.trim() || '') || null;
      const target = cleanTarget(data.nextQuestionTarget, blockIds);
      const supplement = cleanSupplement(data.supplement);
      if (!feedback || target === null || supplement === null) return { ok: false, error: badOutput('学习反馈') };
      return { ok: true, value: { action: 'feedback', verdict: data.verdict, feedback, supplement, nextQuestion: next && isSingleQuestion(next) ? next : null, ...(target ? { nextQuestionTarget: target } : {}) } };
    }
    case 'graded': {
      const rawNextQuiz = data.nextQuiz ? cleanQuizQuestions(data.nextQuiz.questions, blockIds) : null;
      const nextQuiz = rawNextQuiz && rawNextQuiz.questions.every(question => isSingleQuestion(question.text)) ? rawNextQuiz : null;
      const analysis = show(data.analysis.trim());
      const next = show(data.nextQuestion?.trim() || '') || null;
      const target = cleanTarget(data.nextQuestionTarget, blockIds);
      const supplement = cleanSupplement(data.supplement);
      if (!analysis || target === null || supplement === null) return { ok: false, error: badOutput('学习反馈') };
      return { ok: true, value: { action: 'graded', analysis, supplement, notes: data.notes.map(note => ({ questionId: note.questionId.trim(), note: show(note.note.trim()) })).filter(note => note.questionId && note.note), nextQuestion: next && isSingleQuestion(next) ? next : null, ...(target ? { nextQuestionTarget: target } : {}), nextQuiz } };
    }
    case 'hint': {
      const question = show(data.question.trim());
      const hint = show(data.hint.trim());
      if (!hint || !question || !isSingleQuestion(question)) return { ok: false, error: badOutput('学习反馈') };
      return { ok: true, value: { action: 'hint', hint, question } };
    }
    case 'explain': {
      const explanation = show(data.explanation.trim());
      const next = show(data.nextQuestion?.trim() || '') || null;
      const target = cleanTarget(data.nextQuestionTarget, blockIds);
      const supplement = cleanSupplement(data.supplement);
      if (!explanation || target === null || supplement === null) return { ok: false, error: badOutput('学习反馈') };
      return { ok: true, value: { action: 'explain', explanation, supplement, nextQuestion: next && isSingleQuestion(next) ? next : null, ...(target ? { nextQuestionTarget: target } : {}) } };
    }
    case 'summary': {
      const summary = show(data.summary.trim());
      const supplement = cleanSupplement(data.supplement);
      if (!summary || supplement === null) return { ok: false, error: badOutput('学习反馈') };
      return { ok: true, value: { action: 'summary', summary, supplement, coveredTargets: cleanTextList(data.coveredTargets), uncoveredTargets: cleanTextList(data.uncoveredTargets), nextDirections: data.nextDirections.map(item => show(item.trim())).filter(Boolean).slice(0, 3) } };
    }
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
