import { browser } from 'wxt/browser';
import { diagramIdFromUrl, diagramKey, matchesDiagramViewer, parseDiagramRecord, type DiagramRecord } from '../../src/core/diagram-record';
import { DIAGRAM_ICON_PATHS, type DiagramIconName } from '../../src/core/diagram-icons';
import { fitView, resizeView, visibleDiagramRect, zoomAt, type DiagramView, type Size } from '../../src/core/diagram-view';
import { cloneDiagramSvg, prepareDiagramSvg } from '../../src/viewer/svg';
import './style.css';

const root = document.getElementById('root')!;
const ownUrl = browser.runtime.getURL('/viewer.html');
let record: DiagramRecord | null = null;
let currentTabId: number | undefined;

function icon(name: DiagramIconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('tool-icon');
  for (const path of DIAGRAM_ICON_PATHS[name]) {
    const shape = document.createElementNS(svg.namespaceURI, 'path'); shape.setAttribute('d', path); svg.append(shape);
  }
  return svg;
}

function button(label: string, action: () => void, name?: DiagramIconName, text?: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button'; element.title = label; element.setAttribute('aria-label', label);
  if (name) element.append(icon(name));
  if (text) { element.append(document.createTextNode(text)); element.classList.add('text-tool'); }
  element.addEventListener('click', action);
  return element;
}

async function close(): Promise<void> {
  if (record) {
    try {
      const source = await browser.tabs.get(record.sourceTabId);
      await browser.tabs.update(record.sourceTabId, { active: true });
      await browser.windows.update(source.windowId, { focused: true });
    } catch { /* 来源已关闭时仍允许关闭图表。 */ }
    await browser.storage.session.remove(diagramKey(record.id));
  }
  if (currentTabId !== undefined) await browser.tabs.remove(currentTabId).catch(() => window.close());
  else window.close();
}

function message(text: string): void {
  root.textContent = '';
  const box = document.createElement('div'); box.className = 'empty-state';
  const title = document.createElement('h1'); title.textContent = '看图';
  const body = document.createElement('p'); body.textContent = text; body.setAttribute('role', 'status');
  box.append(title, body, button(record ? '返回文章' : '关闭图表', () => void close(), 'close', record ? '返回文章' : '关闭图表'));
  root.append(box);
}

/** 创建记录先于页面，绑定可能稍后完成；监听会话变化而非重复传 SVG。 */
async function load(): Promise<DiagramRecord | null> {
  const tab = await browser.tabs.getCurrent(); currentTabId = tab?.id;
  const id = diagramIdFromUrl(location.href, ownUrl);
  if (!id || !tab) return null;
  const key = diagramKey(id);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value: DiagramRecord | null) => {
      if (finished) return; finished = true;
      clearTimeout(timeout); browser.storage.onChanged.removeListener(changed); resolve(value);
    };
    const inspect = async () => {
      try {
        const stored = await browser.storage.session.get(key);
        const candidate = parseDiagramRecord(stored[key]);
        if (!candidate) { finish(null); return; }
        if (candidate.viewerTabId === undefined) return;
        if (!matchesDiagramViewer(candidate, tab, location.href, ownUrl)) { finish(null); return; }
        const source = await browser.tabs.get(candidate.sourceTabId);
        finish(source.windowId === candidate.sourceWindowId ? candidate : null);
      } catch { finish(null); }
    };
    const changed = (changes: Record<string, unknown>, area: string) => { if (area === 'session' && key in changes) void inspect(); };
    const timeout = setTimeout(() => finish(null), 5000);
    browser.storage.onChanged.addListener(changed); void inspect();
  });
}

function mount(data: DiagramRecord): void {
  const { svg, size } = prepareDiagramSvg(data.svg);
  document.title = `${data.title} · 知伴`;
  root.textContent = '';
  const bar = document.createElement('div'); bar.className = 'bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '图表视图');
  const title = document.createElement('h1'); title.className = 'viewer-title'; title.textContent = data.title; title.title = data.title;
  const label = document.createElement('span'); label.className = 'zoom-label';
  const status = document.createElement('p'); status.className = 'viewer-status'; status.setAttribute('role', 'status');
  const stage = document.createElement('div'); stage.className = 'stage'; stage.tabIndex = 0; stage.setAttribute('role', 'region'); stage.setAttribute('aria-label', '图表画布');
  const canvas = document.createElement('div'); canvas.className = 'canvas'; canvas.append(svg); stage.append(canvas);
  let viewport: Size = { width: 0, height: 0 };
  let view: DiagramView = { scale: 1, x: 0, y: 0, autoFit: true };

  const mini = document.createElement('button'); mini.className = 'minimap'; mini.type = 'button'; mini.setAttribute('aria-label', '全图导航，点击定位');
  const miniLabel = document.createElement('span'); miniLabel.textContent = '全图导航';
  const overview = document.createElementNS(svg.namespaceURI, 'svg'); overview.classList.add('mini-overview'); overview.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`); overview.setAttribute('aria-hidden', 'true');
  overview.setAttribute('width', String(Math.min(180, size.width / size.height * 120)));
  overview.setAttribute('height', String(Math.min(120, size.height / size.width * 180)));
  const copy = cloneDiagramSvg(svg, 'mini-'); overview.append(copy);
  const visible = document.createElementNS(svg.namespaceURI, 'rect'); visible.classList.add('mini-visible'); overview.append(visible);
  mini.append(miniLabel, overview); stage.append(mini);

  const apply = () => {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    label.textContent = `${Math.round(view.scale * 100)}%`;
    label.title = `当前缩放 ${Math.round(view.scale * 100)}%`;
    mini.hidden = view.x >= -1 && view.y >= -1 && view.x + size.width * view.scale <= viewport.width + 1 && view.y + size.height * view.scale <= viewport.height + 1;
    const rect = visibleDiagramRect(view, size, viewport);
    for (const [key, value] of Object.entries(rect)) visible.setAttribute(key, String(value));
  };
  const center = () => ({ x: viewport.width / 2, y: viewport.height / 2 });
  const fit = () => { view = fitView(size, viewport); apply(); };
  const zoom = (factor: number) => { view = zoomAt(view, factor, center()); apply(); };
  const full = button('全屏', () => {
    const request = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.();
    if (!request) status.textContent = '当前无法全屏，可以继续在窗口里看图。';
    else void request.catch(() => { status.textContent = '当前无法全屏，可以继续在窗口里看图。'; });
  }, 'fullscreen');
  const fullChanged = () => {
    const active = Boolean(document.fullscreenElement);
    full.setAttribute('aria-label', active ? '退出全屏' : '全屏'); full.title = active ? '退出全屏' : '全屏';
    full.replaceChildren(icon(active ? 'fullscreenExit' : 'fullscreen'));
  };
  document.addEventListener('fullscreenchange', fullChanged);
  bar.append(title, button('缩小', () => zoom(1 / 1.25), 'zoomOut'), label,
    button('放大', () => zoom(1.25), 'zoomIn'), button('适应画布', fit, 'fit', '适应画布'),
    button('100%', () => zoom(1 / view.scale), undefined, '100%'), full,
    button('返回文章并关闭图表', () => void close(), 'close', '返回文章'));
  root.append(bar, status, stage);
  const hint = document.createElement('p'); hint.className = 'viewer-hint'; hint.textContent = '滚轮缩放 · 拖动移动 · 双击适应画布'; root.append(hint);

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const bounds = stage.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1);
    view = zoomAt(view, Math.exp(Math.max(-2, Math.min(2, -delta * .002))), { x: event.clientX - bounds.left, y: event.clientY - bounds.top }); apply();
  }, { passive: false });
  let drag: { x: number; y: number; view: DiagramView } | null = null;
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target as Element).closest('.minimap')) return;
    drag = { x: event.clientX, y: event.clientY, view }; stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
    if (dx * dx + dy * dy < 9) return;
    view = { ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy, autoFit: false }; apply();
  });
  const stopDrag = () => { drag = null; };
  stage.addEventListener('pointerup', stopDrag); stage.addEventListener('pointercancel', stopDrag);
  stage.addEventListener('dblclick', (event) => { if (!(event.target as Element).closest('.minimap')) fit(); });
  const locate = (event: PointerEvent) => {
    const bounds = overview.getBoundingClientRect();
    const x = Math.min(size.width, Math.max(0, (event.clientX - bounds.left) / bounds.width * size.width));
    const y = Math.min(size.height, Math.max(0, (event.clientY - bounds.top) / bounds.height * size.height));
    view = { ...view, x: viewport.width / 2 - x * view.scale, y: viewport.height / 2 - y * view.scale, autoFit: false }; apply();
  };
  mini.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation(); mini.setPointerCapture(event.pointerId); locate(event); });
  mini.addEventListener('pointermove', (event) => { if (mini.hasPointerCapture(event.pointerId)) locate(event); });
  mini.addEventListener('click', (event) => { if (event.detail === 0) { view = { ...view, x: (viewport.width - size.width * view.scale) / 2, y: (viewport.height - size.height * view.scale) / 2, autoFit: false }; apply(); } });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (document.fullscreenElement) { event.preventDefault(); void document.exitFullscreen(); }
      else void close();
      return;
    }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoom(1 / 1.25); }
    else if (event.key === '0') { event.preventDefault(); fit(); }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); const step = event.shiftKey ? 120 : 40;
      view = { ...view, x: view.x + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0), y: view.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0), autoFit: false }; apply();
    }
  });
  const observer = new ResizeObserver(() => {
    const bounds = stage.getBoundingClientRect();
    const next = { width: bounds.width, height: bounds.height };
    if (!next.width || !next.height) return;
    view = viewport.width ? resizeView(view, size, viewport, next) : fitView(size, next); viewport = next; apply();
  });
  observer.observe(stage);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && diagramKey(data.id) in changes && !changes[diagramKey(data.id)]?.newValue) {
      status.textContent = '来源文章已关闭或图表记录已清除。这张图仍可查看，关闭后请从文章重新打开。';
      const back = bar.lastElementChild as HTMLButtonElement; back.setAttribute('aria-label', '关闭图表'); back.replaceChildren(icon('close'), document.createTextNode('关闭图表'));
    }
  });
}

message('正在打开图表…');
void load().then((data) => {
  record = data;
  if (!data) { message('这张图的记录已失效。请回到文章，重新点击图表打开。'); return; }
  try { mount(data); } catch { message('这张图暂时无法显示。回到文章后可以重新打开。'); }
}).catch(() => message('这张图暂时无法打开。请回到文章重试。'));
