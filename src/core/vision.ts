/**
 * 读图：把模型从图上转述的文字插回正文块。
 * 转述可能有误，不能当成作者原文。看不清的图留在“没读”里，不编内容。
 */

import type { Completeness, EvidenceBlock, PictureRef } from './blocks';

export const VISION_MODEL = 'deepseek-v4-flash-vision-exp';

const VISION_PROMPT =
  '请只根据这张图，用一段中文写清图上能读到的文字和看得见的内容。不要估计图上没有印出来的数字。看不清就直接说看不清。';

const UNREAD = /^(看不清|无法辨认|读不到|图上没有可辨认的内容)[。！]?$/;

export function visionBody(imageUrl: string): Record<string, unknown> {
  return {
    model: VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    thinking: { type: 'disabled' },
    max_tokens: 500,
    stream: false,
  };
}

export function visionTextFrom(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const content = (payload as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim().slice(0, 800) : '';
}

function imageBlock(picture: PictureRef, text: string): EvidenceBlock | null {
  const raw = text.trim().replace(/^图上读到（可能有误）：/, '');
  if (!raw || UNREAD.test(raw)) return null;
  return {
    id: picture.id,
    role: 'image',
    content: `图上读到（可能有误）：${raw}`,
    headingPath: [],
    anchor: picture.anchor,
  };
}

/** 按阅读顺序把读到的图插进正文。没读到的不造块。 */
export function applyImageReadings(
  blocks: EvidenceBlock[],
  pictures: PictureRef[],
  readings: { id: string; text: string }[],
  completeness: Completeness,
): { blocks: EvidenceBlock[]; completeness: Completeness } {
  const textById = new Map(readings.map((item) => [item.id, item.text]));
  const blockFor = (picture: PictureRef) => imageBlock(picture, textById.get(picture.id) ?? '');
  const result: EvidenceBlock[] = [];
  for (const picture of pictures) {
    if (picture.afterBlockId) continue;
    const block = blockFor(picture);
    if (block) result.push(block);
  }
  const seen = new Set(result.map((block) => block.id));
  for (const block of blocks) {
    result.push(block);
    for (const picture of pictures) {
      if (picture.afterBlockId !== block.id) continue;
      const image = blockFor(picture);
      if (!image || seen.has(image.id)) continue;
      result.push(image);
      seen.add(image.id);
    }
  }
  for (const picture of pictures) {
    const image = blockFor(picture);
    if (!image || seen.has(image.id)) continue;
    result.push(image);
    seen.add(image.id);
  }

  const captured = result.filter((block) => block.role === 'image').length;
  const found = completeness.images.found;
  return {
    blocks: result,
    completeness: {
      ...completeness,
      images: {
        status: found === 0 ? 'not-present' : captured === 0 ? 'unavailable' : captured < found ? 'partial' : 'parsed',
        found,
        captured,
      },
    },
  };
}
