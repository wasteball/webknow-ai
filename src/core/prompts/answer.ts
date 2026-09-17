import { z } from 'zod';

import { HARNESS_RULES, SOURCE_DISCIPLINE, randomBoundary, wrapUntrusted } from './harness';

/**
 * 策略二：自由问答。
 * 只由维护者配置，用户没有编辑入口（FR-027）。
 */

export const ANSWER_VERSION = '2026-09-18.1';

export const ANSWER_SOURCES = ['original', 'supplement', 'example', 'extended', 'unknown'] as const;

export const AnswerSchema = z.object({
  answer: z.string().min(1),
  source: z.enum(ANSWER_SOURCES),
  /** 只能填正文块 id；直接引文由程序从本地块取出。 */
  citations: z.array(z.string()),
  unanswered: z.array(z.string()),
});

export type AnswerOutput = z.infer<typeof AnswerSchema>;

const POLICY = [
  '你在网页旁回答读者关于当前文章的问题。优先直接回答，不要把问题改写成学习任务。',
  'source 取你这条回答的主要依据类型；只要主要依据来自正文块，就必须同时给出对应 citations，不能为空。',
  '问题超出文章内容时，可以给出标注清楚的补充解释、假设例子或延伸知识，并在 source 与 unanswered 中如实体现。',
  '你没有联网能力：不要把模型记忆当作实时查证结果，涉及实时事实、最新数据或你无法确认的内容时，写进 unanswered 并说明首版无法确认。',
  '回答使用简体中文，语言平实，不要堆砌小标题，不要写与问题无关的背景介绍。',
  '只返回 JSON：{"answer":"...","source":"original|supplement|example|extended|unknown","citations":["块id"],"unanswered":["..."]}',
].join('\n');

export function answerMessages(input: {
  title: string;
  url: string;
  contextJson: string;
  disclosure: string;
  history: { question: string; answer: string }[];
  question: string;
}) {
  const marker = randomBoundary();
  const payload = JSON.stringify({
    page: { title: input.title, url: input.url },
    disclosure: input.disclosure,
    blocks: JSON.parse(input.contextJson),
    history: input.history,
    question: input.question,
  });
  return [
    { role: 'system' as const, content: `${HARNESS_RULES}\n${SOURCE_DISCIPLINE}\n\n${POLICY}` },
    { role: 'user' as const, content: wrapUntrusted(marker, 'SOURCE', payload) },
  ];
}
