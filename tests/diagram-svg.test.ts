// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { cloneDiagramSvg, prepareDiagramSvg } from '../src/viewer/svg';

it('缩略图的 SVG ID、样式和箭头引用隔离，原图不变', () => {
  const { svg, size } = prepareDiagramSvg('<svg xmlns="http://www.w3.org/2000/svg" id="diagram" viewBox="0 0 2400 200" width="100%"><style>#diagram .edge {marker-end:url(#arrow)}</style><defs><marker id="arrow"/></defs><path id="edge" marker-end="url(#arrow)"/><use href="#edge"/></svg>');
  expect(size).toEqual({ width: 2400, height: 200 });
  expect(svg.style.width).toBe('2400px');
  const copy = cloneDiagramSvg(svg, 'mini-');
  expect(copy.id).not.toBe(svg.id);
  const marker = copy.querySelector('marker')!;
  expect(copy.querySelector('path')!.getAttribute('marker-end')).toBe(`url(#${marker.id})`);
  expect(copy.querySelector('style')!.textContent).toContain(`#${copy.id} .edge`);
  expect(copy.querySelector('use')!.getAttribute('href')).toBe(`#${copy.querySelector('path')!.id}`);
  expect(svg.querySelector('marker')!.id).toBe('arrow');
});

it('不能解析的记录显示失败，不能拿普通 HTML 冒充图表', () => {
  expect(() => prepareDiagramSvg('<div>不是图</div>')).toThrow();
  expect(() => prepareDiagramSvg('<svg xmlns="http://www.w3.org/2000/svg"><broken></svg>')).toThrow();
});
