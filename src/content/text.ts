/**
 * 正文块与锚点的基础工具。来自本项目 2026-08-22 版本（735171c）的 text.ts，
 * 已验证的逻辑只做搬移，不重写。
 */

export function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** 非加密用途：只用于内容版本与锚点指纹，不能作为安全凭据。 */
export function fingerprint(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

export function escapeCss(value: string): string {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

export function cssPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    const peers = [...parent.children].filter((child) => child.tagName === current?.tagName);
    const suffix = peers.length > 1 ? `:nth-of-type(${peers.indexOf(current) + 1})` : '';
    parts.unshift(`${tag}${suffix}`);
    if (current.id) {
      parts[0] = `#${escapeCss(current.id)}`;
      break;
    }
    current = parent;
  }
  return parts.join(' > ');
}
