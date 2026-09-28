export function diagramFit(stage: HTMLElement, svg: SVGSVGElement, scale: number): number {
  if (svg.getAttribute('width') === '100%' && svg.viewBox.baseVal.width > 0) {
    svg.style.width = `${svg.viewBox.baseVal.width}px`;
  }
  const bounds = svg.getBoundingClientRect();
  const width = bounds.width / scale;
  const height = bounds.height / scale;
  if (!width || !height) return 1;
  return Math.min(1, (stage.clientWidth - 32) / width, (stage.clientHeight - 32) / height);
}
