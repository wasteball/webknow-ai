import { z } from 'zod';

import { HARNESS_RULES, SOURCE_DISCIPLINE, randomBoundary, wrapUntrusted } from './harness';

/**
 * 策略一：阅读导览（首屏短摘要 + 探索气泡）。
 * 只由维护者配置，用户没有编辑入口（FR-027）。
 */

export const GUIDE_VERSION = '2026-09-18.1';

/** 气泡方向：互补而非同义改写（FR-009）。 */
export const BUBBLE_KINDS = [
  'concept',
  'reason',
  'premise',
  'example',
  'counter',
  'boundary',
] as const;

export const GuideSchema = z.object({
  summary: z.string().min(1),
  bubbles: z.array(
    z.object({
      question: z.string().min(1),
      // kind 只是内部分类：取到未知值时归一化，而不是让整个首屏失败（用户可见的只有问题文本）。
      kind: z.string(),
    }),
  ),
});

export type GuideOutput = z.infer<typeof GuideSchema>;

const POLICY = [
  '你在为一位普通读者做网页阅读导览，只使用给定正文块。',
  'summary：用简体中文写出短摘要，帮助读者建立全貌——文章讲了什么、关键观点是什么、有哪些必要限制。不要改写成第二篇文章，不要复述细节清单，不要写成推荐语。',
  'bubbles：给 0 到 3 个值得继续探索的方向，每个方向一个具体问题，覆盖互补角度（概念、原因、前提、例子、反例、适用边界）。',
  '每个气泡问题必须指向本文具体内容，不能是“这篇文章讲了什么”这类空问题，也不能用同义改写凑数，不得诱导读者接受作者立场。',
  '正文块不足或内容不适合时，可以减少气泡数量甚至不给，不要为了凑满数量生成低价值问题。',
  '只返回 JSON：{"summary":"...","bubbles":[{"question":"...","kind":"concept|reason|premise|example|counter|boundary"}]}',
].join('\n');

export function guideMessages(input: { title: string; url: string; contextJson: string; disclosure: string }) {
  const marker = randomBoundary();
  const payload = JSON.stringify({
    page: { title: input.title, url: input.url },
    disclosure: input.disclosure,
    blocks: JSON.parse(input.contextJson),
  });
  return [
    { role: 'system' as const, content: `${HARNESS_RULES}\n${SOURCE_DISCIPLINE}\n\n${POLICY}` },
    { role: 'user' as const, content: wrapUntrusted(marker, 'SOURCE', payload) },
  ];
}
