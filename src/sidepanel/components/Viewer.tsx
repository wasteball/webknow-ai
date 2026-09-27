import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from './Icon';

/**
 * 图表查看器：覆盖整个侧栏的浮层，缩放 / 拖拽 / 复位 / 全屏 / 在新标签页里看。
 * 侧栏只有 380–450px 宽，复杂图在内联态一定看不清，这是必要的配套（方案 2.3）。
 *
 * 缩放平移都作用在 wrapper 的 transform 上，不改 SVG 内部，因此不会重排、不会模糊。
 */

const MIN = 0.5;
const MAX = 8;

export function Viewer({ svg, onClose }: { svg: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const shell = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  // 侧栏里 requestFullscreen 未必可用；不可用时不摆这个按钮，免得点了没反应。
  const canFullscreen = typeof document.fullscreenEnabled === 'boolean' ? document.fullscreenEnabled : false;

  useEffect(() => {
    if (host.current) host.current.innerHTML = svg;
  }, [svg]);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // 焦点陷阱 + Esc 关闭：浮层是对话框，键盘必须能进能出（FR-036）。
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    shell.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'Tab' && shell.current) {
        const focusable = shell.current.querySelectorAll<HTMLElement>('button');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, [onClose]);

  // 以指针位置为锚点缩放：手感上「图跟着光标走」，而不是整张图往中心跳。
  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left - box.width / 2;
    const py = event.clientY - box.top - box.height / 2;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(MAX, Math.max(MIN, scale * factor));
    const ratio = next / scale;
    setOffset((current) => ({
      x: px - (px - current.x) * ratio,
      y: py - (py - current.y) * ratio,
    }));
    setScale(next);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const start = drag.current;
    if (!start) return;
    setOffset({ x: start.ox + (event.clientX - start.x), y: start.oy + (event.clientY - start.y) });
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const toggleFullscreen = () => {
    const element = shell.current;
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen?.().catch(() => undefined);
  };

  /** 在新标签页里看：侧栏宽度不够时的兜底，走扩展内页面，不落盘、不外发。 */
  const openInTab = async () => {
    const { browser } = await import('wxt/browser');
    const tab = await browser.tabs.create({ url: browser.runtime.getURL('/viewer.html') });
    // 新页面挂上监听后才要图；轮询几次即可，不需要额外的握手协议。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      try {
        if (tab.id) await browser.tabs.sendMessage(tab.id, { type: 'diagram', svg });
        return;
      } catch {
        // 页面还没准备好，继续等。
      }
    }
  };

  return (
    <div
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label="放大看图"
      tabIndex={-1}
      ref={shell}
    >
      <div className="viewer-bar">
        <button type="button" className="quiet" onClick={() => setScale((s) => Math.max(MIN, s / 1.4))} aria-label="缩小">
          －
        </button>
        <span className="viewer-scale">{Math.round(scale * 100)}%</span>
        <button type="button" className="quiet" onClick={() => setScale((s) => Math.min(MAX, s * 1.4))} aria-label="放大">
          ＋
        </button>
        <button type="button" className="quiet" onClick={reset}>
          复位
        </button>
        <button type="button" className="quiet" onClick={() => void openInTab()}>
          新标签页
        </button>
        {canFullscreen && (
          <button type="button" className="quiet" onClick={toggleFullscreen}>
            全屏
          </button>
        )}
        <button type="button" className="quiet viewer-close" onClick={onClose} aria-label="关闭">
          <Icon name="x" small />
        </button>
      </div>
      <div
        className="viewer-stage"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
      >
        <div
          className="viewer-canvas"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          ref={host}
        />
      </div>
      <p className="viewer-hint">滚轮缩放 · 拖动平移 · 双击复位 · Esc 关闭</p>
    </div>
  );
}
