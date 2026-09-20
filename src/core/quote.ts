/**
 * 划词提问：读者在网页上圈一段话，再写问题。
 * 原文必须能对上本地块才给回跳；对不上也不编造块 id。
 */

export const QUOTE_MIN_CHARS = 4;
export const QUOTE_MAX_CHARS = 500;

export type Quote = {
  text: string;
  blockId: string | null;
};

function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

export function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function isUsableQuote(text: string): boolean {
  const clean = normalizeQuote(text);
  return clean.length >= QUOTE_MIN_CHARS;
}

export function clipQuote(text: string): string {
  const clean = normalizeQuote(text);
  if (clean.length <= QUOTE_MAX_CHARS) return clean;
  return `${clean.slice(0, QUOTE_MAX_CHARS)}…`;
}

export function blockIdForQuote(
  blocks: { id: string; content: string }[],
  text: string,
): string | null {
  const needle = compact(normalizeQuote(text));
  if (needle.length < QUOTE_MIN_CHARS) return null;
  const hits = blocks
    .map((block) => ({ id: block.id, compact: compact(block.content) }))
    .filter((block) => block.compact.includes(needle));
  if (!hits.length) return null;
  hits.sort((left, right) => left.compact.length - right.compact.length);
  return hits[0]?.id ?? null;
}

export function prepareQuote(
  text: string,
  blocks: { id: string; content: string }[],
): Quote | null {
  if (!isUsableQuote(text)) return null;
  const clipped = clipQuote(text);
  return { text: clipped, blockId: blockIdForQuote(blocks, clipped) };
}
