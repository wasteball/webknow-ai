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

let gestureAt = 0;
let saved: { text: string; range: Range; at: number } | null = null;
let anchor: Range | null = null;

function usable(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length >= 4;
}

function hide(): void {
  anchor = null;
  document.getElementById(HOST_ID)?.remove();
}

function fromOwnUi(event: Event): boolean {
  const isHost = (node: EventTarget | null): boolean => {
    if (!node || typeof node !== 'object') return false;
    return 'id' in node && (node as { id?: unknown }).id === HOST_ID;
  };
  if (event.composedPath().some((node) => isHost(node))) return true;
  return isHost(event.target);
}

const SKIP_KEY = '__wkaSkipQuoteUp';

function ask(text: string): void {
  const now = Date.now();
  const until = (globalThis as typeof globalThis & { [SKIP_KEY]?: number })[SKIP_KEY] ?? 0;
  // 窗口和按钮可能都收到同一次按下。第二次不再发。
  if (now < until) return;
  // 按下和松开不在同一次调用里。松开后的一小段里不要按选区把按钮再建出来。
  (globalThis as typeof globalThis & { [SKIP_KEY]?: number })[SKIP_KEY] = now + 400;
  hide();
  void browser.runtime.sendMessage({ type: 'quoteSelected', text: clipQuote(text) }).catch(() => {
    // 后台暂时不可达时忽略：用户再点一次即可。
  });
}

function place(host: HTMLElement, rect: DOMRect): void {
  // 微信自己的菜单贴在选区上方。按钮放在选区下面，点得到。
  const below = rect.bottom + 8;
  const top = below + 36 <= window.innerHeight ? below : Math.max(8, rect.top - 44);
  const left = Math.min(window.innerWidth - 88, Math.max(8, rect.left));
  host.style.top = `${top}px`;
  host.style.left = `${left}px`;
}

function remember(): void {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const text = selection.toString();
  if (!usable(text)) return;
  saved = { text, range: selection.getRangeAt(0).cloneRange(), at: Date.now() };
}

/** 松开时页面可能已经把选区清掉。这一次按下之后记过的原文还算数。 */
function selectionForGesture(): { text: string; range: Range } | null {
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const text = selection.toString();
    if (usable(text)) return { text, range: selection.getRangeAt(0) };
  }
  if (saved && saved.at >= gestureAt) return saved;
  return null;
}

function ensureSelectable(): void {
  let style = document.getElementById(SELECT_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = SELECT_STYLE_ID;
    style.textContent =
      '#js_content,#js_content *,.rich_media_content,.rich_media_content *,article,article *{user-select:text !important;-webkit-user-select:text !important}';
  }
  // 挪到最后，压过页面后来注入的禁止选择。
  document.documentElement.append(style);
  const root = document.querySelector('#js_content, .rich_media_content, article');
  if (root instanceof HTMLElement) {
    root.style.setProperty('user-select', 'text', 'important');
    root.style.setProperty('-webkit-user-select', 'text', 'important');
  }
}

function show(range: Range, text: string): void {
  hide();
  anchor = range.cloneRange();
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.quote = text;
  host.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:auto;';
  place(host, range.getBoundingClientRect());
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
  const activate = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    ask(text);
  };
  // 页面可能在捕获阶段吃掉 mousedown；click 是最后一道可达的按钮事件。
  button?.addEventListener('pointerdown', activate);
  button?.addEventListener('mousedown', activate);
  button?.addEventListener('click', activate);
  document.documentElement.append(host);
}

function onPointerDown(event: Event): void {
  if (fromOwnUi(event)) return;
  gestureAt = Date.now();
}

/** 在窗口捕获阶段按下就发出。页面在 document 上拦住事件时，按钮自己的监听收不到。 */
function onActivate(event: Event): void {
  if (!fromOwnUi(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const text = document.getElementById(HOST_ID)?.dataset.quote ?? '';
  if (text) ask(text);
}

function onMouseUp(event: Event): void {
  const until = (globalThis as typeof globalThis & { [SKIP_KEY]?: number })[SKIP_KEY] ?? 0;
  if (Date.now() < until) return;
  if (fromOwnUi(event)) return;
  ensureSelectable();
  remember();
  const picked = selectionForGesture();
  if (!picked) {
    hide();
    return;
  }
  show(picked.range, picked.text);
}

function onScroll(): void {
  const host = document.getElementById(HOST_ID);
  if (!host || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const gone = rect.width === 0 && rect.height === 0;
  if (gone || rect.bottom <= 0 || rect.top >= window.innerHeight) {
    hide();
    return;
  }
  place(host, rect);
}

export function startQuoteAsk(): void {
  const scope = globalThis as typeof globalThis & { __wkaQuoteAsk?: boolean };
  if (scope.__wkaQuoteAsk) return;
  scope.__wkaQuoteAsk = true;
  ensureSelectable();
  // 选区变化时先记下原文：微信会在松开的捕获阶段把选区清掉，等到 mouseup 就晚了。
  addEventListener('selectionchange', remember, true);
  addEventListener('pointerdown', onPointerDown, true);
  addEventListener('mousedown', onActivate, true);
  addEventListener('pointerup', onMouseUp, true);
  addEventListener('mouseup', onMouseUp, true);
  addEventListener('scroll', onScroll, true);
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
}
