import { Readability } from '@mozilla/readability';
import type {
  CaptureResult,
  CompletenessReport,
  DomAnchor,
  EvidenceBlock,
  JumpResult,
} from './contracts';
import { cssPath, escapeCss, fingerprint, normalizeText } from './text';

const ANCHOR_ATTRIBUTE = 'data-wka-anchor';
const CANDIDATES = 'h1,h2,h3,h4,h5,h6,p,li,th,td';
const MIN_ARTICLE_CHARS = 80;
const HIGHLIGHT_ID = 'wka-evidence-highlight-style';
const HIGHLIGHT_CLASS = 'wka-evidence-highlight';
const OWN_ANCHOR_SELECTOR = `[${ANCHOR_ATTRIBUTE}^="wka-"]`;

type SourceCandidate = {
  element: HTMLElement;
  id: string;
  text: string;
  headingPath: string[];
  selector: string;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
};

function headingPathAt(element: Element): string[] {
  const headings = [...document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')];
  const path: string[] = [];
  for (const heading of headings) {
    if (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const level = Number(heading.tagName[1]);
      path.splice(level - 1);
      path[level - 1] = normalizeText(heading.textContent);
    }
  }
  return path.filter(Boolean);
}

function cleanHeadingPath(root: Element, element: Element): string[] {
  const path: string[] = [];
  for (const heading of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    if (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const level = Number(heading.tagName[1]);
      path.splice(level - 1);
      path[level - 1] = normalizeText(heading.textContent);
    }
  }
  return path.filter(Boolean);
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function annotateSource(sessionId: string): SourceCandidate[] {
  clearAnchors();
  const elements = [...document.querySelectorAll<HTMLElement>(CANDIDATES)].filter((element) => {
    const text = normalizeText(element.textContent);
    return (
      text.length >= (element.matches('p') ? 20 : 2) && !element.closest('[aria-hidden="true"]')
    );
  });
  let position = 0;
  return elements.map((element, index) => {
    const text = normalizeText(element.textContent);
    const id = `wka-${sessionId}-${index.toString(36)}`;
    element.setAttribute(ANCHOR_ATTRIBUTE, id);
    const start = position;
    position += text.length + 1;
    return {
      element,
      id,
      text,
      headingPath: headingPathAt(element),
      selector: cssPath(element),
      start,
      end: start + text.length,
      prefix: normalizeText(elements[index - 1]?.textContent).slice(-100),
      suffix: normalizeText(elements[index + 1]?.textContent).slice(0, 100),
    };
  });
}

function roleOf(element: Element): EvidenceBlock['role'] {
  if (/^H[1-6]$/.test(element.tagName)) return 'heading';
  if (element.matches('li')) return 'list-item';
  if (element.matches('th,td')) return 'table-cell';
  return 'paragraph';
}

function tableContext(element: Element): EvidenceBlock['context']['table'] {
  if (!element.matches('th,td')) return undefined;
  const cell = element as HTMLTableCellElement;
  const row = cell.parentElement as HTMLTableRowElement | null;
  const table = cell.closest('table');
  const index = row ? [...row.cells].indexOf(cell) : -1;
  const header = table?.querySelectorAll<HTMLTableCellElement>('thead th')[index];
  const first = row?.cells[0];
  const context: NonNullable<EvidenceBlock['context']['table']> = {};
  const caption = normalizeText(table?.querySelector('caption')?.textContent);
  const column = normalizeText(header?.textContent);
  const rowLabel = first !== cell ? normalizeText(first?.textContent) : '';
  if (caption) context.caption = caption;
  if (column) context.column = column;
  if (rowLabel) context.row = rowLabel;
  return context;
}

function makeBlock(
  element: HTMLElement,
  source: SourceCandidate,
  method: EvidenceBlock['provenance']['method'],
  sessionId: string,
  title: string,
  url: string,
): EvidenceBlock {
  const content = normalizeText(element.textContent);
  const anchorFingerprint = fingerprint(`${content}\n${source.headingPath.join(' > ')}`);
  const context: EvidenceBlock['context'] = { headingPath: source.headingPath };
  const table = tableContext(source.element);
  if (table) context.table = table;
  return {
    id: `b_${fingerprint(`${sessionId}:${source.id}:${content}`)}`,
    sessionId,
    modality: element.matches('th,td') ? 'table' : 'text',
    role: roleOf(element),
    content,
    context,
    source: { url, title },
    anchor: {
      sessionAnchorId: source.id,
      selector: source.selector,
      exact: content,
      prefix: source.prefix,
      suffix: source.suffix,
      textPosition: { start: source.start, end: source.end },
      headingPath: source.headingPath,
      fingerprint: anchorFingerprint,
    },
    provenance: { parser: 'readability', method },
    integrity: { fingerprint: anchorFingerprint, completeness: 'complete' },
    sourceLevel: 'L1',
  };
}

function clearAnchors(except = new Set<string>()): void {
  for (const element of document.querySelectorAll(OWN_ANCHOR_SELECTOR)) {
    const id = element.getAttribute(ANCHOR_ATTRIBUTE);
    if (!id || !except.has(id)) element.removeAttribute(ANCHOR_ATTRIBUTE);
  }
}

function parseFailure(message: string): CaptureResult {
  clearAnchors();
  return {
    ok: false,
    error: { code: 'PARSE_FAILED', retryable: false, message },
  };
}

export function documentFingerprint(): string {
  const clone = document.cloneNode(true) as Document;
  const sourceImages = [...document.images];
  clone.querySelectorAll<HTMLImageElement>('img').forEach((image, index) => {
    const source = sourceImages[index];
    image.dataset.wkaFingerprintSource = source?.currentSrc || source?.src || '';
  });
  const article = new Readability(clone).parse();
  if (!article?.content) return fingerprint(`${location.href}\n${document.title}\nunreadable`);
  const root = new DOMParser().parseFromString(`<main>${article.content}</main>`, 'text/html').body;
  const content = [...root.querySelectorAll(CANDIDATES)]
    .map((element) => normalizeText(element.textContent))
    .filter(Boolean)
    .join('\n');
  const images = [...root.querySelectorAll<HTMLImageElement>('img')]
    .map((image) => `${image.dataset.wkaFingerprintSource}\t${normalizeText(image.alt)}`)
    .join('\n');
  return fingerprint(`${location.href}\n${document.title}\n${content}\n${images}`);
}

export function captureDocument(sessionId: string): CaptureResult {
  const source = annotateSource(sessionId);
  const byId = new Map(source.map((candidate) => [candidate.id, candidate]));
  const clone = document.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  if (!article?.content) return parseFailure('未识别到可核查的文章正文。');

  const root = new DOMParser().parseFromString(`<main>${article.content}</main>`, 'text/html').body;
  const cleanCandidates = [...root.querySelectorAll<HTMLElement>(CANDIDATES)];
  let excludedAmbiguousBlocks = 0;
  const blocks: EvidenceBlock[] = [];
  for (const element of cleanCandidates) {
    const content = normalizeText(element.textContent);
    if (content.length < (element.matches('p') ? 20 : 2)) continue;
    const retainedId = element.getAttribute(ANCHOR_ATTRIBUTE);
    let match = retainedId ? byId.get(retainedId) : undefined;
    let method: EvidenceBlock['provenance']['method'] = 'retained-anchor';
    if (!match || match.text !== content) {
      const cleanPath = cleanHeadingPath(root, element);
      const candidates = source.filter(
        (candidate) => candidate.text === content && samePath(candidate.headingPath, cleanPath),
      );
      match = candidates.length === 1 ? candidates[0] : undefined;
      method = 'unique-text';
    }
    if (!match) {
      excludedAmbiguousBlocks += 1;
      continue;
    }
    blocks.push(
      makeBlock(element, match, method, sessionId, article.title || document.title, location.href),
    );
  }

  const capturedChars = blocks.reduce((total, block) => total + block.content.length, 0);
  if (capturedChars < MIN_ARTICLE_CHARS || blocks.length < 3) {
    return parseFailure(
      `正文过短或无法建立足够的唯一原文锚点（已建立 ${blocks.length} 块、${capturedChars} 字符）。`,
    );
  }

  const textFound = cleanCandidates.filter((element) => !element.matches('th,td')).length;
  const tableFound = root.querySelectorAll('th,td').length;
  const imageFound = root.querySelectorAll('img').length;
  const textCaptured = blocks.filter((block) => block.modality === 'text').length;
  const tableCaptured = blocks.filter((block) => block.modality === 'table').length;
  const warnings: string[] = [];
  if (excludedAmbiguousBlocks)
    warnings.push(`${excludedAmbiguousBlocks} 个正文块无法唯一定位，未纳入证据。`);
  if (imageFound) warnings.push(`发现 ${imageFound} 张图片；当前版本未解析图片内容。`);
  const completeness: CompletenessReport = {
    scope: 'readability-article',
    text: {
      status: textCaptured === textFound ? 'parsed' : 'partial',
      found: textFound,
      captured: textCaptured,
    },
    tables: {
      status: tableFound ? (tableCaptured === tableFound ? 'parsed' : 'partial') : 'not-present',
      found: tableFound,
      captured: tableCaptured,
    },
    images: {
      status: imageFound ? 'unavailable' : 'not-present',
      found: imageFound,
      captured: 0,
      ...(imageFound ? { note: '需要视觉模型；本切片未启用。' } : {}),
    },
    excludedAmbiguousBlocks,
    warnings,
  };
  clearAnchors(new Set(blocks.map((block) => block.anchor.sessionAnchorId)));
  const state = warnings.length ? 'READY_PARTIAL' : 'READY_COMPLETE';
  return {
    ok: true,
    title: article.title || document.title,
    url: location.href,
    fingerprint: documentFingerprint(),
    state,
    blocks,
    completeness,
  };
}

function currentCandidates(): SourceCandidate[] {
  const elements = [...document.querySelectorAll<HTMLElement>(CANDIDATES)].filter(
    (element) => normalizeText(element.textContent).length >= 2,
  );
  let position = 0;
  return elements.map((element, index) => {
    const text = normalizeText(element.textContent);
    const start = position;
    position += text.length + 1;
    return {
      element,
      id: element.getAttribute(ANCHOR_ATTRIBUTE) ?? '',
      text,
      headingPath: headingPathAt(element),
      selector: cssPath(element),
      start,
      end: start + text.length,
      prefix: normalizeText(elements[index - 1]?.textContent).slice(-100),
      suffix: normalizeText(elements[index + 1]?.textContent).slice(0, 100),
    };
  });
}

function highlight(element: HTMLElement): void {
  document.querySelector(`.${HIGHLIGHT_CLASS}`)?.classList.remove(HIGHLIGHT_CLASS);
  let style = document.getElementById(HIGHLIGHT_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = HIGHLIGHT_ID;
    style.textContent = `.${HIGHLIGHT_CLASS}{outline:3px solid #d96b38!important;outline-offset:4px!important;background-color:rgba(217,107,56,.16)!important}`;
    document.documentElement.append(style);
  }
  element.classList.add(HIGHLIGHT_CLASS);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
}

export function disposeHighlight(): void {
  document.querySelector(`.${HIGHLIGHT_CLASS}`)?.classList.remove(HIGHLIGHT_CLASS);
}

export function jumpToAnchor(anchor: DomAnchor): JumpResult {
  const directMatches = document.querySelectorAll<HTMLElement>(
    `[${ANCHOR_ATTRIBUTE}="${escapeCss(anchor.sessionAnchorId)}"]`,
  );
  const direct = directMatches.length === 1 ? directMatches[0] : undefined;
  if (
    direct &&
    normalizeText(direct.textContent) === anchor.exact &&
    fingerprint(`${normalizeText(direct.textContent)}\n${headingPathAt(direct).join(' > ')}`) ===
      anchor.fingerprint
  ) {
    highlight(direct);
    return { outcome: 'jumped' };
  }

  const candidates = currentCandidates();
  const matches = candidates.filter(
    (candidate) =>
      candidate.text === anchor.exact &&
      samePath(candidate.headingPath, anchor.headingPath) &&
      candidate.prefix === anchor.prefix &&
      candidate.suffix === anchor.suffix,
  );

  if (anchor.selector && matches.length === 1) {
    try {
      const selectedMatches = document.querySelectorAll<HTMLElement>(anchor.selector);
      const selected = selectedMatches.length === 1 ? selectedMatches[0] : undefined;
      if (selected && selected === matches[0]?.element) {
        highlight(selected);
        return { outcome: 'relocated' };
      }
    } catch {
      // Invalid selectors are treated as failed evidence locations.
    }
  }

  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match) {
    return {
      outcome: 'failed',
      reason: matches.length ? '原文存在多个相同位置，无法安全定位。' : '原位置已变化。',
    };
  }
  highlight(match.element);
  return { outcome: 'relocated' };
}
