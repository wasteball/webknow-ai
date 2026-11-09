import { browser } from 'wxt/browser';

/**
 * 页内浮层（右侧停靠面板）：面板本身仍是扩展页 sidepanel.html，装在网页里的 iframe 中，
 * 所以端口、权限、外发确认、停止等能力和 Chrome 侧栏完全一样；网页脚本读不到 iframe 里的内容。
 * 放不进网页的页面（chrome://、应用商店、PDF 查看器、扩展页等）改用 Chrome 侧栏。
 */

const CONTENT_FILE = '/content-scripts/content.js';

/** 只看地址就能同步判断：必须在用户手势里同步决定要不要打开 Chrome 侧栏。 */
export function overlayCapable(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  // Chrome 不允许扩展往应用商店注入脚本。
  if (parsed.hostname === 'chromewebstore.google.com' ||
      (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))) return false;
  // 直接打开的 PDF 由浏览器内置查看器显示，页面里放不进浮层。
  if (/\.pdf$/i.test(parsed.pathname)) return false;
  return true;
}

export type OverlayCommand = { type: 'overlay'; action: 'open' | 'toggle' | 'close'; tabId: number };

/** 注入内容脚本并让它打开 / 切换浮层。失败时返回 false，由调用方决定要不要提示。 */
export async function sendOverlay(tabId: number, action: OverlayCommand['action']): Promise<boolean> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] });
    const reply = await browser.tabs.sendMessage(tabId, { type: 'overlay', action, tabId } satisfies OverlayCommand) as { ok?: boolean } | undefined;
    return reply?.ok === true;
  } catch {
    return false;
  }
}
