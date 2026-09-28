import { z } from 'zod';

import { SUMMARY_LENGTH_CHARS, type SummaryLength } from '../limits';
import { DIAGRAMS_DISABLED, HARNESS_RULES, MARKDOWN_DISCIPLINE, SOURCE_DISCIPLINE, randomBoundary, wrapUntrusted } from './harness';

/**
 * 策略一：阅读导览（首屏短摘要 + 探索气泡）。
 * 产品化改造后与“AI 问我”一样开放策略段覆盖（用户设置），但 harness 与输出契约仍由代码拼接。
 */

export const GUIDE_VERSION = '2026-09-28.1';

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

export const GUIDE_DEFAULT_POLICY = (params: {
  maxBubbles: number;
  summaryMaxChars: number;
}): string =>
  [
    '你在为一位普通读者做网页阅读导览，只使用给定正文块。',
    `summary：用简体中文写出短摘要（不超过 ${params.summaryMaxChars} 字），帮助读者建立全貌——文章讲了什么、关键观点是什么、有哪些必要限制。不要改写成第二篇文章，不要复述细节清单，不要写成推荐语。`,
    `bubbles：给 0 到 ${params.maxBubbles} 个能靠本文回答的具体问题，优先选帮助读者理解关键概念、理由或限制的角度。角度不必齐全；原文确实提供了例子、反例或边界时才问这些内容。`,
    '每个气泡围绕一个原文中的具体点，用读者能听懂的说法；不能是“这篇文章讲了什么”这类空问题，也不能用同义改写凑数，不得诱导读者接受作者立场。',
    '正文块不足或内容不适合时，可以减少气泡数量甚至不给，不要为了凑满数量生成低价值问题。',
  ].join('\n');

const GUIDE_CONTRACT = [
  '导览只使用当前原文；不添加外部知识、生活类比、虚构反例或新情境。摘要与气泡均不得出现原文无依据的说法，资料不足就缩短摘要或减少气泡。',
  '只返回 JSON：{"summary":"...","bubbles":[{"question":"...","kind":"concept|reason|premise|example|counter|boundary"}]}',
].join('\n');

/** 覆盖只作用于策略段；传空或不传则使用内置默认值。 */
export function guideSystem(
  override: string | undefined,
  params: { maxBubbles: number; summaryMaxChars: number },
): string {
  const policy = override?.trim() ? override.trim() : GUIDE_DEFAULT_POLICY(params);
  // 首屏保持短摘要；来源与图表规则在策略后重申，已保存的旧预设也须遵守。
  return [HARNESS_RULES, policy, SOURCE_DISCIPLINE, MARKDOWN_DISCIPLINE, DIAGRAMS_DISABLED, GUIDE_CONTRACT].join('\n\n');
}

export function summaryCharsFor(length: SummaryLength): number {
  return SUMMARY_LENGTH_CHARS[length] ?? SUMMARY_LENGTH_CHARS.medium;
}

export function guideMessages(input: {
  title: string;
  url: string;
  contextJson: string;
  disclosure: string;
  override?: string;
  maxBubbles: number;
  summaryMaxChars: number;
}) {
  const marker = randomBoundary();
  const payload = JSON.stringify({
    page: { title: input.title, url: input.url },
    disclosure: input.disclosure,
    blocks: JSON.parse(input.contextJson),
  });
  return [
    {
      role: 'system' as const,
      content: guideSystem(input.override, {
        maxBubbles: input.maxBubbles,
        summaryMaxChars: input.summaryMaxChars,
      }),
    },
    { role: 'user' as const, content: wrapUntrusted(marker, 'SOURCE', payload) },
  ];
}
