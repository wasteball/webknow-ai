/**
 * 划词提问：用户划完一段，旁边出现「问这句」。
 * 只在开始伴读（watch）之后听选取，不扫描页面、不把划词自动外发。
 *
 * 点按钮必须在 mousedown 里发出：真实顺序是 pointerdown → mousedown → pointerup → mouseup → click。
 * 窗口抬起若按划词重建按钮，原来的节点已经不在，click 永远打不到。
 * 过长的选区裁到引用上限再发，不能因为字多就把按钮藏掉。
 */

import { clipQuote } from '../core/quote';

const HOST_ID = 'wka-quote-ask';
const SELECT_STYLE_ID = 'wka-quote-select';
const SCROLL_GRACE_MS = 600;

function usable(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length >= 4;
}

function hide(): void {
  document.getElementById(HOST_ID)?.remove();
}

function fromOwnUi(event: Event): boolean {
  return event.composedPath().some((node) => node instanceof Element && node.id === HOST_ID);
}

const SKIP_KEY = '__wkaSkipQuoteUp';

function ask(text: string): void {
  // 按下和松开不在同一次调用里。松开后的一小段里不要按选区把按钮再建出来。
  (globalThis as typeof globalThis & { [SKIP_KEY]?: number })[SKIP_KEY] = Date.now() + 400;
  hide();
  void browser.runtime.sendMessage({ type: 'quoteSelected', text: clipQuote(text) }).catch(() => {
    // 后台暂时不可达时忽略：用户再点一次即可。
  });
}

let shownAt = 0;

function ensureSelectable(): void {
  if (document.getElementById(SELECT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SELECT_STYLE_ID;
  style.textContent =
    '#js_content,#js_content *,.rich_media_content,.rich_media_content *,article,article *{user-select:text !important;-webkit-user-select:text !important}';
  document.documentElement.append(style);
}

function show(range: Range, text: string): void {
  hide();
  const rect = range.getBoundingClientRect();
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = `position:fixed;z-index:2147483646;top:${Math.max(8, rect.top - 44)}px;left:${Math.min(window.innerWidth - 88, Math.max(8, rect.right - 12))}px;`;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      button {
        font: 650 13px/1.2 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #f7f4ef;
        background: #b42318;
        border: 0;
        border-radius: 999px;
        min-height: 36px;
        padding: 0 12px;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(28, 24, 20, .18);
      }
      button:hover { background: #8e1a12; }
    </style>
    <button type="button">问这句</button>
  `;
  const button = root.querySelector('button');
  button?.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    ask(text);
  });
  document.documentElement.append(host);
  shownAt = Date.now();
}

function onMouseUp(event: Event): void {
  const until = (globalThis as typeof globalThis & { [SKIP_KEY]?: number })[SKIP_KEY] ?? 0;
  if (Date.now() < until) return;
  if (fromOwnUi(event)) return;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    hide();
    return;
  }
  const text = selection.toString();
  if (!usable(text)) {
    hide();
    return;
  }
  show(selection.getRangeAt(0), text);
}

function onScroll(): void {
  if (Date.now() - shownAt < SCROLL_GRACE_MS) return;
  hide();
}

export function startQuoteAsk(): void {
  const scope = globalThis as typeof globalThis & { __wkaQuoteAsk?: boolean };
  if (scope.__wkaQuoteAsk) return;
  scope.__wkaQuoteAsk = true;
  ensureSelectable();
  // 捕获阶段先于页面自己的 mouseup，避免页面把选区清掉之后我们什么都看不到。
  addEventListener('pointerup', onMouseUp, true);
  addEventListener('mouseup', onMouseUp, true);
  addEventListener('scroll', onScroll, true);
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
}
