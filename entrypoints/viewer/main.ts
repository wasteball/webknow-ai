import { browser } from 'wxt/browser';

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

function apply() {
  if (canvas) canvas.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`;
}

function mount(svg: string) {
  if (!root) return;
  root.textContent = '';
  scale = 1;
  offset = { x: 0, y: 0 };

  const stage = document.createElement('div');
  stage.className = 'stage';
  canvas = document.createElement('div');
  canvas.className = 'canvas';
  canvas.innerHTML = svg;
  stage.append(canvas);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const label = document.createElement('span');
  const setLabel = () => {
    label.textContent = `${Math.round(scale * 100)}%`;
  };
  const button = (text: string, onClick: () => void) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.addEventListener('click', onClick);
    return element;
  };
  const zoom = (factor: number) => {
    scale = Math.min(8, Math.max(0.25, scale * factor));
    setLabel();
    apply();
  };
  const smaller = button('－', () => zoom(1 / 1.4));
  smaller.setAttribute('aria-label', '缩小');
  const larger = button('＋', () => zoom(1.4));
  larger.setAttribute('aria-label', '放大');
  bar.append(
    smaller,
    label,
    larger,
    button('复位', () => {
      scale = 1;
      offset = { x: 0, y: 0 };
      setLabel();
      apply();
    }),
  );
  const status = document.createElement('p');
  status.className = 'viewer-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const fullscreen = button('全屏', () => {
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
  document.addEventListener('fullscreenchange', () => {
    fullscreen.textContent = document.fullscreenElement === root ? '退出全屏' : '全屏';
    status.textContent = '';
  });
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
  stage.addEventListener('dblclick', () => {
    scale = 1;
    offset = { x: 0, y: 0 };
    setLabel();
    apply();
  });

  root.append(bar, status, stage);
  apply();
}

browser.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message === 'object' && message && (message as { type?: string }).type === 'diagram') {
    mount(String((message as { svg?: string }).svg ?? ''));
  }
});
