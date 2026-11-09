import { browser } from 'wxt/browser';

/**
 * 页内浮层：右侧停靠、全高，默认 400px，可拖左边缘调宽并记住宽度，可收起成边上的小把手。
 *
 * 面板本身是扩展页（sidepanel.html），装在 iframe 里：网页脚本读不到里面的内容，
 * 端口、权限、外发确认等能力和 Chrome 侧栏完全一样。宿主元素用封闭的 shadow root，
 * 网页的样式影响不到它，它也不改网页本身的布局（盖在网页上，不挤压正文）。
 */

const HOST_ID = 'wka-overlay';
const WIDTH_KEY = 'overlayWidth';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 320;
const FLAG = '__wkaOverlay';

type OverlayState = { host: HTMLElement; root: ShadowRoot; open: boolean };

function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.7));
}

export function clampWidth(value: unknown, viewport = window.innerWidth): number {
  const max = Math.max(MIN_WIDTH, Math.round(viewport * 0.7));
  const width = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_WIDTH;
  return Math.min(max, Math.max(MIN_WIDTH, width));
}

const STYLE = `
:host { all: initial; }
.dock { position: fixed; top: 0; right: 0; height: 100vh; z-index: 2147483646; display: flex;
  box-shadow: -8px 0 24px rgba(28, 27, 46, .16); background: #fff; }
.dock[hidden] { display: none; }
.grip { width: 6px; margin-left: -3px; cursor: ew-resize; background: transparent; flex: none; position: relative; z-index: 1; }
.grip:hover, .grip.dragging { background: rgba(91, 75, 219, .35); }
iframe { border: 0; width: 100%; height: 100%; display: block; color-scheme: normal; }
.frame { flex: 1; min-width: 0; position: relative; }
.shield { position: absolute; inset: 0; display: none; }
.dragging-on .shield { display: block; }
.tab { position: fixed; top: 40%; right: 0; z-index: 2147483646; width: 36px; height: 44px; border: 0;
  border-radius: 10px 0 0 10px; background: #5b4bdb; color: #fff; cursor: pointer; font: 600 13px system-ui, sans-serif;
  box-shadow: -4px 4px 14px rgba(28, 27, 46, .22); display: flex; align-items: center; justify-content: center; }
.tab[hidden] { display: none; }
.tab:focus-visible { outline: 2px solid #1c1b2e; outline-offset: 2px; }
@media (prefers-color-scheme: dark) { .dock { background: #121218; } }
`;

function state(): OverlayState | undefined {
  return (globalThis as typeof globalThis & { [FLAG]?: OverlayState })[FLAG];
}

function create(tabId: number): OverlayState {
  const existing = state();
  if (existing && document.getElementById(HOST_ID) === existing.host) return existing;
  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;

  const dock = document.createElement('div');
  dock.className = 'dock';
  dock.setAttribute('role', 'complementary');
  dock.setAttribute('aria-label', 'WebKnow AI');
  dock.style.width = `${DEFAULT_WIDTH}px`;

  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.title = '拖动调整宽度';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', '拖动调整 WebKnow AI 面板宽度');
  grip.tabIndex = 0;

  const frameWrap = document.createElement('div');
  frameWrap.className = 'frame';
  const frame = document.createElement('iframe');
  // 面板按 tab 参数绑定到这个标签页，不跟着“当前激活的标签页”走。
  frame.src = browser.runtime.getURL(`/sidepanel.html?host=overlay&tab=${tabId}`);
  frame.title = 'WebKnow AI';
  frame.setAttribute('allow', 'clipboard-write');
  const shield = document.createElement('div');
  shield.className = 'shield';
  frameWrap.append(frame, shield);
  dock.append(grip, frameWrap);

  const tab = document.createElement('button');
  tab.className = 'tab';
  tab.type = 'button';
  tab.textContent = 'AI';
  tab.title = '展开 WebKnow AI';
  tab.setAttribute('aria-label', '展开 WebKnow AI');
  tab.hidden = true;
  tab.addEventListener('click', () => show(true));

  root.append(style, dock, tab);
  document.documentElement.append(host);

  const setWidth = (value: number, save: boolean) => {
    const width = clampWidth(value);
    dock.style.width = `${width}px`;
    if (save) void browser.storage.local.set({ [WIDTH_KEY]: width }).catch(() => {});
  };
  void browser.storage.local.get(WIDTH_KEY).then((stored) => setWidth(Number(stored[WIDTH_KEY]), false), () => {});

  grip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add('dragging');
    dock.classList.add('dragging-on');
    const move = (next: PointerEvent) => setWidth(window.innerWidth - next.clientX, false);
    const end = (next: PointerEvent) => {
      grip.releasePointerCapture(next.pointerId);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      grip.classList.remove('dragging');
      dock.classList.remove('dragging-on');
      setWidth(window.innerWidth - next.clientX, true);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
  grip.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const current = dock.getBoundingClientRect().width;
    setWidth(current + (event.key === 'ArrowLeft' ? 24 : -24), true);
  });
  window.addEventListener('resize', () => setWidth(dock.getBoundingClientRect().width, false));

  const next: OverlayState = { host, root, open: true };
  (globalThis as typeof globalThis & { [FLAG]?: OverlayState })[FLAG] = next;
  return next;
}

function show(open: boolean): void {
  const current = state();
  if (!current) return;
  current.open = open;
  const dock = current.root.querySelector<HTMLElement>('.dock');
  const tab = current.root.querySelector<HTMLButtonElement>('.tab');
  if (dock) dock.hidden = !open;
  if (tab) tab.hidden = open;
  if (!open) tab?.focus({ preventScroll: true });
}

/** 后台发来的打开 / 切换 / 收起。tabId 由后台给：内容脚本自己拿不到。 */
export function handleOverlay(action: 'open' | 'toggle' | 'close', tabId: number | undefined): boolean {
  const current = state();
  if (action === 'close') { show(false); return true; }
  if (!current || document.getElementById(HOST_ID) !== current.host) {
    if (tabId === undefined) return false;
    create(tabId);
    show(true);
    return true;
  }
  show(action === 'open' ? true : !current.open);
  return true;
}

export const OVERLAY_LIMITS = { DEFAULT_WIDTH, MIN_WIDTH, maxWidth };
