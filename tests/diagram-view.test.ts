import { describe, expect, it } from 'vitest';
import { fitView, resizeView, zoomAt, visibleDiagramRect } from '../src/core/diagram-view';

describe('独立图表视角', () => {
  it.each([{ width: 2400, height: 200 }, { width: 200, height: 2000 }])('宽高图都完整适配：%j', (diagram) => {
    const viewport = { width: 1000, height: 600 };
    const view = fitView(diagram, viewport);
    expect(view.scale).toBeGreaterThan(0);
    expect(view.x).toBeGreaterThanOrEqual(24);
    expect(view.y).toBeGreaterThanOrEqual(24);
    expect(view.x + diagram.width * view.scale).toBeLessThanOrEqual(viewport.width - 24 + .01);
    expect(view.y + diagram.height * view.scale).toBeLessThanOrEqual(viewport.height - 24 + .01);
  });
  it('小图居中但不强行放大', () => {
    expect(fitView({ width: 200, height: 100 }, { width: 1000, height: 600 }))
      .toEqual({ scale: 1, x: 400, y: 250, autoFit: true });
  });
  it('指针下的节点在缩放后仍在同一个位置', () => {
    const view = { scale: 1, x: 20, y: 10, autoFit: false };
    expect(zoomAt(view, 2, { x: 70, y: 30 })).toEqual({ scale: 2, x: -30, y: -10, autoFit: false });
    const clamped = zoomAt(view, 100, { x: 70, y: 30 });
    expect(clamped.scale).toBe(8);
    expect((70 - clamped.x) / clamped.scale).toBe(50);
  });
  it('手动视角在 resize 后保留中心节点和缩放比例', () => {
    const view = { scale: 2, x: -700, y: -200, autoFit: false };
    const next = resizeView(view, { width: 2400, height: 2000 }, { width: 1000, height: 600 }, { width: 600, height: 400 });
    expect(next.scale).toBe(2);
    expect((300 - next.x) / next.scale).toBe((500 - view.x) / view.scale);
    expect((200 - next.y) / next.scale).toBe((300 - view.y) / view.scale);
  });
  it('自动适配在 resize 后重新适配', () => {
    const diagram = { width: 2400, height: 2000 };
    const previous = { width: 1000, height: 600 };
    const next = { width: 600, height: 400 };
    expect(resizeView(fitView(diagram, previous), diagram, previous, next)).toEqual(fitView(diagram, next));
  });
  it('缩略导航只显示图中的可见区域', () => {
    expect(visibleDiagramRect({ scale: 1, x: -800, y: -100, autoFit: false },
      { width: 2400, height: 2000 }, { width: 1000, height: 600 }))
      .toEqual({ x: 800, y: 100, width: 1000, height: 600 });
  });
});
