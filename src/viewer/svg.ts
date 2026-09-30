import type { Size } from '../core/diagram-view';

/** 输入仅是 strict Mermaid 的本地输出；DOMParser 避免接受普通 HTML 记录。 */
export function prepareDiagramSvg(text: string): { svg: SVGSVGElement; size: Size } {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const element = parsed.documentElement;
  if (element.localName !== 'svg' || element.namespaceURI !== 'http://www.w3.org/2000/svg' || parsed.querySelector('parsererror')) throw new Error('图表无法读取');
  const box = (element.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const width = box.length === 4 ? box[2]! : Number.parseFloat(element.getAttribute('width') ?? '');
  const height = box.length === 4 ? box[3]! : Number.parseFloat(element.getAttribute('height') ?? '');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('图表尺寸无效');
  const svg = document.importNode(element, true) as unknown as SVGSVGElement;
  svg.style.maxWidth = 'none'; svg.style.width = `${width}px`; svg.style.height = `${height}px`;
  svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
  return { svg, size: { width, height } };
}

/** 导航副本必须重命名所有 ID 以及本地引用，包括 Mermaid 的根节点 CSS。 */
export function cloneDiagramSvg(svg: SVGSVGElement, prefix: string): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const ids = new Map<string, string>();
  [clone, ...clone.querySelectorAll('[id]')].forEach((element, index) => {
    if (element.id) { ids.set(element.id, `${prefix}${index}`); element.id = `${prefix}${index}`; }
  });
  const replace = (text: string) => {
    for (const [before, after] of ids) {
      const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`#${escaped}(?=[\\s)"'{}.:>~+\\[\\],]|$)`, 'g'), `#${after}`);
    }
    return text;
  };
  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name === 'id') continue;
      element.setAttribute(attribute.name, replace(attribute.value));
    }
    if (element.localName === 'style') element.textContent = replace(element.textContent ?? '');
  }
  return clone;
}
