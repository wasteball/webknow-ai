import type { EvidenceBlock } from './blocks';
import { appError, type AppError } from './errors';
import { LIMITS } from './limits';
import { AnswerSchema } from './prompts/answer';
import { BUBBLE_KINDS, GuideSchema } from './prompts/guide';
import { LearnSchema, type LearnMode } from './prompts/learn';
import type { AnswerSource, Bubble, BubbleKind, Citation, Verdict } from './session';

/**
 * 程序侧校验：模型输出只是候选，写入会话前必须通过结构与引用校验（FR-016/FR-029）。
 * 这里不做“猜测性修补”——不确定的内容宁可降级或丢弃，也不假装可信。
 */

export type Clean<T> = { ok: true; value: T } | { ok: false; error: AppError };

const BAD_OUTPUT_RUNAWAY = 4_000;

function badOutput(what: string): AppError {
  return appError('BAD_OUTPUT', `${what}结构不符合要求，本次结果未采用。可重试。`, true);
}

export function cleanGuide(parsed: unknown): Clean<{ summary: string; bubbles: Bubble[] }> {
  const result = GuideSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: badOutput('首屏结果') };

  const summary = result.data.summary.trim();
  if (!summary || summary.length > BAD_OUTPUT_RUNAWAY) {
    return { ok: false, error: badOutput('摘要') };
  }

  const seen = new Set<string>();
  const bubbles: Bubble[] = [];
  for (const [index, bubble] of result.data.bubbles.entries()) {
    const question = bubble.question.trim();
    if (!question || question.length > LIMITS.bubbleQuestionMaxChars * 4) continue;
    const key = question.replace(/\s+/g, '').replace(/[？?。.!！]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = (BUBBLE_KINDS as readonly string[]).includes(bubble.kind)
      ? (bubble.kind as BubbleKind)
      : 'concept';
    bubbles.push({ id: `bub_${index}`, question, kind });
    if (bubbles.length >= LIMITS.maxBubbles) break;
  }

  return { ok: true, value: { summary, bubbles } };
}

export function cleanAnswer(
  parsed: unknown,
  blocks: EvidenceBlock[],
): Clean<{
  answer: string;
  source: AnswerSource;
  citations: Citation[];
  unanswered: string[];
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
  let source: AnswerSource = result.data.source;
  if (source === 'original' && citations.length === 0) {
    // 声称来自原文却拿不出可核对依据：降级为“无法确认”，不把模型知识写成作者原话。
    source = 'unknown';
    unanswered.push('这条回答未能在当前正文中找到可直接核对的依据，因此未标为原文依据。');
  }

  return { ok: true, value: { answer, source, citations, unanswered } };
}

export type LearnResult =
  | { action: 'question'; question: string }
  | {
      action: 'feedback';
      verdict: Verdict;
      feedback: string;
      nextQuestion: string | null;
    }
  | { action: 'hint'; hint: string; question: string }
  | { action: 'explain'; explanation: string; nextQuestion: string | null }
  | { action: 'summary'; summary: string; nextDirections: string[] };

/** mode → 允许的动作：模型返回与请求模式不一致时视为无效输出，不发散解释。 */
const EXPECTED: Record<LearnMode, 'question' | 'feedback' | 'hint' | 'explain' | 'summary'> = {
  ask: 'question',
  respond: 'feedback',
  hint: 'hint',
  explain: 'explain',
  close: 'summary',
};

export function cleanLearn(parsed: unknown, mode: LearnMode): Clean<LearnResult> {
  const result = LearnSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: badOutput('学习反馈') };
  const data = result.data;
  if (data.action !== EXPECTED[mode]) return { ok: false, error: badOutput('学习反馈') };

  switch (data.action) {
    case 'question':
      return { ok: true, value: { action: 'question', question: data.question.trim() } };
    case 'feedback':
      return {
        ok: true,
        value: {
          action: 'feedback',
          verdict: data.verdict,
          feedback: data.feedback.trim(),
          nextQuestion: data.nextQuestion?.trim() || null,
        },
      };
    case 'hint':
      return {
        ok: true,
        value: { action: 'hint', hint: data.hint.trim(), question: data.question.trim() },
      };
    case 'explain':
      return {
        ok: true,
        value: {
          action: 'explain',
          explanation: data.explanation.trim(),
          nextQuestion: data.nextQuestion?.trim() || null,
        },
      };
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
    return { ok: false, error: appError('BAD_OUTPUT', '教学提示词不能为空。', false) };
  }
  if (value.length > LIMITS.maxTeachingPromptChars) {
    return {
      ok: false,
      error: appError(
        'BAD_OUTPUT',
        `教学提示词超过 ${LIMITS.maxTeachingPromptChars} 字符上限，已保留上一次有效内容。`,
        false,
      ),
    };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return { ok: false, error: appError('BAD_OUTPUT', '教学提示词包含不可见控制字符。', false) };
  }
  return { ok: true, value };
}
