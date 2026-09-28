import { browser } from 'wxt/browser';

import { diagramFit } from '../../src/core/diagram-fit';
import { DIAGRAM_ICON_PATHS, type DiagramIconName } from '../../src/core/diagram-icons';

import './style.css';

/**
 * 「在新标签页里看」的全窗口图表页面。
 *
 * 侧栏只有 380–450px 宽，复杂图在那里一定看不清；这一页不受侧栏宽度限制。
 * SVG 由侧栏经 runtime 消息送来，不落盘、不外发、不进 URL。
 * 只接受来自本扩展的消息（runtime.onMessage 天然限定发送方为同一扩展）。
 */

const root = document.getElementById('root');

let scale = 1;
let offset = { x: 0, y: 0 };
let canvas: HTMLDivElement | null = null;
let controller = new AbortController();

function icon(name: DiagramIconName) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('tool-icon');
  for (const path of DIAGRAM_ICON_PATHS[name]) {
    const shape = document.createElementNS(namespace, 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
  }
  return svg;
}

function apply() {
  if (canvas) canvas.style.transform = `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`;
}

function mount(svg: string) {
  if (!root) return;
  controller.abort();
  controller = new AbortController();
  root.textContent = '';
  scale = 1;
  offset = { x: 0, y: 0 };

  const stage = document.createElement('div');
  stage.className = 'stage';
  const fit = () => {
    const diagram = canvas?.querySelector('svg');
    if (!diagram) return;
    const next = diagramFit(stage, diagram, scale);
    scale = next;
    offset = { x: 0, y: 0 };
    setLabel();
    apply();
  };
  canvas = document.createElement('div');
  canvas.className = 'canvas';
  canvas.innerHTML = svg;
  stage.append(canvas);

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '图表视图');
  const label = document.createElement('span');
  label.className = 'zoom-label';
  const setLabel = () => {
    label.textContent = `${Math.round(scale * 100)}%`;
  };
  const button = (name: DiagramIconName, text: string, onClick: () => void) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.setAttribute('aria-label', text);
    element.title = text;
    element.append(icon(name));
    element.addEventListener('click', onClick);
    return element;
  };
  const zoom = (factor: number) => {
    scale = Math.min(8, Math.max(0.02, scale * factor));
    setLabel();
    apply();
  };
  bar.append(button('zoomOut', '缩小', () => zoom(1 / 1.4)),
    button('zoomIn', '放大', () => zoom(1.4)), button('fit', '复位', fit), label);
  const status = document.createElement('p');
  status.className = 'viewer-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const fullscreen = button('fullscreen', '全屏', () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {
        status.textContent = '退出全屏失败，请按 Esc。';
      });
    } else if (document.fullscreenEnabled) {
      void root.requestFullscreen().catch(() => {
        status.textContent = '无法全屏，可以在这个整页标签页里看图。';
      });
    } else {
      status.textContent = '无法全屏，可以在这个整页标签页里看图。';
    }
  });
  const updateFullscreenButton = () => {
    const active = document.fullscreenElement === root;
    fullscreen.setAttribute('aria-label', active ? '退出全屏' : '全屏');
    fullscreen.title = active ? '退出全屏' : '全屏';
    fullscreen.replaceChildren(icon(active ? 'fullscreenExit' : 'fullscreen'));
  };
  document.addEventListener('fullscreenchange', () => {
    updateFullscreenButton();
    status.textContent = '';
  }, { signal: controller.signal });
  bar.append(fullscreen);
  setLabel();

  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false },
  );

  let drag: { x: number; y: number; ox: number; oy: number } | null = null;
  stage.addEventListener('pointerdown', (event) => {
    stage.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag) return;
    offset = { x: drag.ox + (event.clientX - drag.x), y: drag.oy + (event.clientY - drag.y) };
    apply();
  });
  const stop = () => {
    drag = null;
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);
  stage.addEventListener('dblclick', fit);

  root.append(bar, status, stage);
  fit();
  window.addEventListener('resize', fit, { signal: controller.signal });
  document.addEventListener('fullscreenchange', fit, { signal: controller.signal });
}

browser.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message === 'object' && message && (message as { type?: string }).type === 'diagram') {
    mount(String((message as { svg?: string }).svg ?? ''));
  }
});
