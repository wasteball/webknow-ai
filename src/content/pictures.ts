/**
 * 内容图：从页面上挑出值得读的图，并在页面上下文里压成 jpeg。
 * 微信图常用 data-src，且 CDN 允许页面自己拉取（Access-Control-Allow-Origin: *）。
 */

import { LIMITS } from '../core/limits';

const MIN_EDGE = 80;
const SKIP_CLASS = /(?:^|[\s_-])(emoji|icon|qrcode|qr)(?:$|[\s_-])/i;
const MAX_BLOB_BYTES = 8_000_000;
const MAX_DATA_URL_CHARS = 1_800_000;

/** 图片的可请求地址。页面里的属性已经解开了 HTML 转义。 */
export function contentImageUrl(image: HTMLImageElement): string {
  const raw =
    image.currentSrc ||
    image.getAttribute('src') ||
    image.getAttribute('data-src') ||
    image.getAttribute('data-original') ||
    '';
  const cleaned = raw.replace(/&amp;/g, '&').trim();
  if (!cleaned || cleaned.startsWith('blob:') || cleaned.startsWith('data:image/svg')) return '';
  try {
    const url = new URL(cleaned, location.href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.href;
  } catch {
    return '';
  }
}

/** 正文里的图，丢掉表情、二维码、小图标。 */
export function isContentImage(image: HTMLImageElement): boolean {
  if (!contentImageUrl(image)) return false;
  const cls = `${typeof image.className === 'string' ? image.className : ''} ${image.parentElement?.className ?? ''}`;
  if (SKIP_CLASS.test(cls)) return false;
  const declared = Number(image.getAttribute('data-w') || image.getAttribute('data-width') || '');
  if (Number.isFinite(declared) && declared > 0 && declared < MIN_EDGE) return false;
  if (image.naturalWidth > 0 && image.naturalWidth < MIN_EDGE) return false;
  const around = (image.closest('p,section,figure')?.textContent ?? '').replace(/\s+/g, '');
  if (/微信扫一扫|长按识别/.test(around) && around.length < 40) return false;
  return true;
}

/** 在页面里把图压成长边不超过上限的 jpeg。失败返回 null，调用方改用原地址。 */
export async function capturePageImage(url: string): Promise<string | null> {
  if (!url.startsWith('https:') && !url.startsWith('http:')) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size > MAX_BLOB_BYTES) return null;
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, LIMITS.maxImageEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const data = canvas.toDataURL('image/jpeg', 0.82);
    return data.length > MAX_DATA_URL_CHARS ? null : data;
  } catch {
    return null;
  }
}
