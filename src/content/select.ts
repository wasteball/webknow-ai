/**
 * 划词提问：用户划完一段，旁边出现「问这句」。
 * 只在开始伴读（watch）之后听选取，不扫描页面、不把划词自动外发。
 */

const HOST_ID = 'wka-quote-ask';

function usable(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length >= 4 && clean.length <= 800;
}

function hide(): void {
  document.getElementById(HOST_ID)?.remove();
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
  button?.addEventListener('mousedown', (event) => event.preventDefault());
  button?.addEventListener('click', () => {
    hide();
    void browser.runtime.sendMessage({ type: 'quoteSelected', text });
  });
  document.documentElement.append(host);
}

function onMouseUp(): void {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    hide();
    return;
  }
  const node = selection.anchorNode;
  if (node && (node instanceof Element ? node : node.parentElement)?.closest(`#${HOST_ID}`)) return;
  const text = selection.toString();
  if (!usable(text)) {
    hide();
    return;
  }
  show(selection.getRangeAt(0), text);
}

export function startQuoteAsk(): void {
  const scope = globalThis as typeof globalThis & { __wkaQuoteAsk?: boolean };
  if (scope.__wkaQuoteAsk) return;
  scope.__wkaQuoteAsk = true;
  addEventListener('mouseup', onMouseUp);
  addEventListener('scroll', hide, true);
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
}
