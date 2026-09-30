export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type DiagramView = Point & { scale: number; autoFit: boolean };

/** 所有视图使用画布左上角坐标，不依赖缩放后的 DOM 尺寸。 */
export function fitView(diagram: Size, viewport: Size): DiagramView {
  const scale = Math.min(1, Math.max(1, viewport.width - 48) / diagram.width, Math.max(1, viewport.height - 48) / diagram.height);
  return { scale, x: (viewport.width - diagram.width * scale) / 2, y: (viewport.height - diagram.height * scale) / 2, autoFit: true };
}

export function zoomAt(view: DiagramView, factor: number, point: Point): DiagramView {
  const scale = Math.max(.01, Math.min(8, view.scale * factor));
  const ratio = scale / view.scale;
  return { scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, autoFit: false };
}

export function resizeView(view: DiagramView, diagram: Size, previous: Size, next: Size): DiagramView {
  return view.autoFit ? fitView(diagram, next)
    : { ...view, x: view.x + (next.width - previous.width) / 2, y: view.y + (next.height - previous.height) / 2 };
}

export function visibleDiagramRect(view: DiagramView, diagram: Size, viewport: Size): Point & Size {
  const x = Math.min(diagram.width, Math.max(0, -view.x / view.scale));
  const y = Math.min(diagram.height, Math.max(0, -view.y / view.scale));
  const right = Math.min(diagram.width, Math.max(0, (viewport.width - view.x) / view.scale));
  const bottom = Math.min(diagram.height, Math.max(0, (viewport.height - view.y) / view.scale));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}
