import { Readability } from '@mozilla/readability';

import type {
  BlockRole,
  BlocksPayload,
  Completeness,
  Coverage,
  CoverageStatus,
  DomAnchor,
  EvidenceBlock,
  JumpOutcome,
} from '../core/blocks';
import { appError } from '../core/errors';
import { LIMITS } from '../core/limits';
import { cssPath, escapeCss, fingerprint, normalizeText } from './text';
import {
  CANDIDATE_SELECTOR,
  cloneExpanded,
  queryAllAcrossTrees,
  readableRoots,
  type ReadableRoot,
} from './trees';

/**
 * 正文提取与原文定位。核心算法来自本项目 2026-08-22 版本（735171c）的 page.ts，
 * 只做两处调整：适配新的块结构，以及把失败统一成 AppError。
 *
 * 这里只在用户点击“开始伴读”后由后台显式调用，内容脚本自身不做任何自动读取（FR-005）。
 */

const ANCHOR_ATTRIBUTE = 'data-wka-anchor';
const CANDIDATES = CANDIDATE_SELECTOR;
const HIGHLIGHT_ID = 'wka-evidence-highlight-style';
const HIGHLIGHT_CLASS = 'wka-evidence-highlight';
const OWN_ANCHOR_SELECTOR = `[${ANCHOR_ATTRIBUTE}^="wka-"]`;

type SourceCandidate = {
  element: HTMLElement;
  id: string;
  text: string;
  headingPath: string[];
  selector: string;
  prefix: string;
  suffix: string;
};

function headingPathIn(root: ReadableRoot, element: Element): string[] {
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

function clearAnchors(except = new Set<string>()): void {
  for (const { element } of anchorElements()) {
    const id = element.getAttribute(ANCHOR_ATTRIBUTE);
    if (!id || !except.has(id)) element.removeAttribute(ANCHOR_ATTRIBUTE);
  }
}

/** 锚点元素可能存在于主文档、shadow root 或同源框架里，统一按可读子树枚举。 */
function anchorElements(): { element: HTMLElement; root: ReadableRoot }[] {
  const { roots } = readableRoots();
  return roots.flatMap((root) =>
    [...root.querySelectorAll<HTMLElement>(OWN_ANCHOR_SELECTOR)].map((element) => ({ element, root })),
  );
}

function minCharsFor(element: Element): number {
  return element.matches('p') ? 20 : 2;
}

function annotateSource(runId: string): SourceCandidate[] {
  clearAnchors();
  const { roots } = readableRoots();
  // 按子树顺序拉平：编号、前后缀、标题路径都基于同一份顺序，提取与回跳必须一致。
  const found = roots.flatMap((root) =>
    [...root.querySelectorAll<HTMLElement>(CANDIDATES)]
      .filter((element) => {
        const text = normalizeText(element.textContent);
        return text.length >= minCharsFor(element) && !element.closest('[aria-hidden="true"]');
      })
      .map((element) => ({ element, root })),
  );
  return found.map(({ element, root }, index) => {
    const text = normalizeText(element.textContent);
    const id = `wka-${runId}-${index.toString(36)}`;
    element.setAttribute(ANCHOR_ATTRIBUTE, id);
    return {
      element,
      id,
      text,
      headingPath: headingPathIn(root, element),
      selector: cssPath(element),
      prefix: normalizeText(found[index - 1]?.element.textContent).slice(-100),
      suffix: normalizeText(found[index + 1]?.element.textContent).slice(0, 100),
    };
  });
}

function blockFromCandidate(match: SourceCandidate, index: number): EvidenceBlock {
  return {
    id: `b_${index.toString(36)}`,
    role: roleOf(match.element),
    content: match.text,
    headingPath: match.headingPath,
    table: tableContext(match.element),
    anchor: {
      sessionAnchorId: match.id,
      selector: match.selector,
      exact: match.text,
      prefix: match.prefix,
      suffix: match.suffix,
      headingPath: match.headingPath,
      fingerprint: fingerprint(`${match.text}\n${match.headingPath.join(' > ')}`),
    },
  };
}

function enoughContent(blocks: EvidenceBlock[]): boolean {
  const chars = blocks.reduce((total, block) => total + block.content.length, 0);
  return chars >= LIMITS.minArticleChars && blocks.length >= LIMITS.minBlocks;
}

function roleOf(element: Element): BlockRole {
  if (/^H[1-6]$/.test(element.tagName)) return 'heading';
  if (element.matches('li')) return 'list-item';
  if (element.matches('th,td')) return 'table-cell';
  return 'paragraph';
}

function tableContext(element: Element): EvidenceBlock['table'] {
  if (!element.matches('th,td')) return undefined;
  const cell = element as HTMLTableCellElement;
  const row = cell.parentElement as HTMLTableRowElement | null;
  const table = cell.closest('table');
  const index = row ? [...row.cells].indexOf(cell) : -1;
  const header = table?.querySelectorAll<HTMLTableCellElement>('thead th')[index];
  const first = row?.cells[0];
  const context: NonNullable<EvidenceBlock['table']> = {};
  const caption = normalizeText(table?.querySelector('caption')?.textContent);
  const column = normalizeText(header?.textContent);
  const rowLabel = first !== cell ? normalizeText(first?.textContent) : '';
  if (caption) context.caption = caption;
  if (column) context.column = column;
  if (rowLabel) context.row = rowLabel;
  return context;
}

/** 内容版本：同一 URL 下正文发生实质变化时，旧结果必须失效（FR-005）。 */
function parseArticle(doc: Document) {
  return new Readability(doc).parse();
}

export function documentFingerprint(): string {
  // 展开克隆顺带把图片的真实地址写进副本，因此不再需要按索引对齐。
  const clone = cloneExpanded(document) as Document;
  const article = parseArticle(clone);
  if (!article?.content) return fingerprint(`${location.href}\n${document.title}\nunreadable`);
  const root = new DOMParser().parseFromString(`<main>${article.content}</main>`, 'text/html').body;
  const content = [...root.querySelectorAll(CANDIDATES)]
    .map((element) => normalizeText(element.textContent))
    .filter(Boolean)
    .join('\n');
  const images = [...root.querySelectorAll<HTMLImageElement>('img')]
    .map((image) => `${image.getAttribute('src') ?? ''}\t${normalizeText(image.alt)}`)
    .join('\n');
  return fingerprint(`${location.href}\n${document.title}\n${content}\n${images}`);
}

function coverage(status: CoverageStatus, found: number, captured: number): Coverage {
  return { status, found, captured };
}

/**
 * 检测“可能还有没加载的内容”。
 *
 * 刻意**不自动滚动**去加载：滚动会改变用户正在读的位置、触发页面自己去发网络请求
 * （广告、埋点），还可能根本停不下来。对阅读伴随工具来说，这些副作用比收益大。
 *
 * 取而代之：只在页面上真的存在“展开全文/加载更多”这类入口时如实披露；
 * 用户自己点开后，正文变化会让内容版本失效（STALE），重新开始伴读即可读到新内容——
 * 已有的“变化即失效”机制正好覆盖这条路径。
 */
const UNLOADED_HINT = /(展开全文|阅读全文|查看全文|加载更多|查看更多|继续阅读|load more|read more|show more)/i;

function detectUnloadedHints(): string[] {
  const hints = new Set<string>();
  for (const element of queryAllAcrossTrees<HTMLElement>('button,a,[role="button"]')) {
    const text = normalizeText(element.textContent);
    // 限制长度：避免把恰好包含这些词的长段落误判成按钮。
    if (!text || text.length > 16) continue;
    if (UNLOADED_HINT.test(text)) hints.add(text);
    if (hints.size >= 3) break;
  }
  return [...hints];
}

export function extractDocument(): BlocksPayload {
  const contentType = document.contentType ?? 'text/html';
  if (!contentType.includes('html')) {
    throw appError('PAGE_UNSUPPORTED', '这一页不是普通的网页文章（可能是文件或特殊页面），现在读不了。');
  }

  const runId = Math.random().toString(36).slice(2, 8);
  const { stats } = readableRoots();
  const source = annotateSource(runId);
  const byId = new Map(source.map((candidate) => [candidate.id, candidate]));
  const clone = cloneExpanded(document) as Document;
  const article = parseArticle(clone);

  let excludedBlocks = 0;
  let blocks: EvidenceBlock[] = [];
  let usedFallback = false;
  let root: HTMLElement | null = null;

  if (article?.content) {
    root = new DOMParser().parseFromString(`<main>${article.content}</main>`, 'text/html').body;
    const cleanCandidates = [...root.querySelectorAll<HTMLElement>(CANDIDATES)];

    for (const element of cleanCandidates) {
      const content = normalizeText(element.textContent);
      if (content.length < minCharsFor(element)) continue;
      const retainedId = element.getAttribute(ANCHOR_ATTRIBUTE);
      let match = retainedId ? byId.get(retainedId) : undefined;
      if (!match || match.text !== content) {
        const path = headingPathAtFrom(root, element);
        const candidates = source.filter(
          (candidate) => candidate.text === content && samePath(candidate.headingPath, path),
        );
        match = candidates.length === 1 ? candidates[0] : undefined;
      }
      // 无法唯一的块宁可剔除也不放进证据集：引用必须能回到确定位置（FR-016/FR-017）。
      if (!match) {
        excludedBlocks += 1;
        continue;
      }
      blocks.push(blockFromCandidate({ ...match, text: content }, blocks.length));
    }
  }

  if (!enoughContent(blocks)) {
    const fallback = source.map((candidate, index) => blockFromCandidate(candidate, index));
    if (enoughContent(fallback)) {
      blocks = fallback;
      excludedBlocks = 0;
      usedFallback = true;
    } else {
      clearAnchors();
      throw appError(
        'EXTRACT_FAILED',
        article?.content
          ? '这一页的文字太少，凑不出完整的内容。换一篇正常文章试试。'
          : '这一页找不到成篇的文字。目前只支持文章类网页；列表页、搜索结果、复杂的网页应用、主要靠图片说话的页面都读不了。',
      );
    }
  }

  const textFound = root
    ? [...root.querySelectorAll<HTMLElement>(CANDIDATES)].filter((element) => !element.matches('th,td')).length
    : source.filter((candidate) => candidate.element.tagName !== 'TH' && candidate.element.tagName !== 'TD').length;
  const tableFound = root ? root.querySelectorAll('th,td').length : source.filter((candidate) => candidate.element.matches('th,td')).length;
  const imageFound = (root ?? document).querySelectorAll('img').length;
  const textCaptured = blocks.filter((block) => block.role !== 'table-cell').length;
  const tableCaptured = blocks.filter((block) => block.role === 'table-cell').length;

  const warnings: string[] = [];
  const hints = detectUnloadedHints();
  if (hints.length) {
    warnings.push(`页面上有「${hints.join('、')}」，可能还有没展开的内容没有读到。`);
  }
  if (usedFallback) warnings.push('这一页不太像完整文章，按页面上的文字块读取。');
  if (excludedBlocks) warnings.push(`${excludedBlocks} 个正文块无法唯一定位，未纳入证据。`);
  if (imageFound) warnings.push(`发现 ${imageFound} 张图片；首版不解析图片内容。`);

  const completeness: Completeness = {
    scope: 'readability-article',
    text: coverage(
      textCaptured === textFound ? 'parsed' : 'partial',
      textFound,
      textCaptured,
    ),
    tables: coverage(
      tableFound ? (tableCaptured === tableFound ? 'parsed' : 'partial') : 'not-present',
      tableFound,
      tableCaptured,
    ),
    images: coverage(imageFound ? 'unavailable' : 'not-present', imageFound, 0),
    frames: coverage(
      stats.framesFound === 0
        ? 'not-present'
        : stats.framesRead === stats.framesFound
          ? 'parsed'
          : 'partial',
      stats.framesFound,
      stats.framesRead,
    ),
    excludedBlocks,
    truncated: false,
    warnings,
  };

  clearAnchors(new Set(blocks.map((block) => block.anchor.sessionAnchorId)));
  return {
    title: article?.title || document.title,
    url: location.href,
    fingerprint: documentFingerprint(),
    blocks,
    completeness,
  };
}

/** 与 headingPathAt 相同，但只在正文根节点范围内计算，避免页面其他标题干扰。 */
function headingPathAtFrom(root: Element, element: Element): string[] {
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

function currentCandidates(): SourceCandidate[] {
  const { roots } = readableRoots();
  const found = roots.flatMap((root) =>
    [...root.querySelectorAll<HTMLElement>(CANDIDATES)]
      .filter((element) => normalizeText(element.textContent).length >= 2)
      .map((element) => ({ element, root })),
  );
  return found.map(({ element, root }, index) => ({
    element,
    id: element.getAttribute(ANCHOR_ATTRIBUTE) ?? '',
    text: normalizeText(element.textContent),
    headingPath: headingPathIn(root, element),
    selector: cssPath(element),
    prefix: normalizeText(found[index - 1]?.element.textContent).slice(-100),
    suffix: normalizeText(found[index + 1]?.element.textContent).slice(0, 100),
  }));
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

/**
 * 回到原文：校验块 id、摘录一致与内容版本，任一不成立就如实报失效，不假装跳转成功（FR-017）。
 */
export function jumpToAnchor(anchor: DomAnchor): JumpOutcome {
  const { roots } = readableRoots();
  const directMatches = roots.flatMap((root) =>
    [...root.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTRIBUTE}="${escapeCss(anchor.sessionAnchorId)}"]`)].map(
      (element) => ({ element, root }),
    ),
  );
  const direct = directMatches.length === 1 ? directMatches[0] : undefined;
  if (
    direct &&
    normalizeText(direct.element.textContent) === anchor.exact &&
    fingerprint(
      `${normalizeText(direct.element.textContent)}\n${headingPathIn(direct.root, direct.element).join(' > ')}`,
    ) === anchor.fingerprint
  ) {
    highlight(direct.element);
    return { outcome: 'jumped' };
  }

  const matches = currentCandidates().filter(
    (candidate) =>
      candidate.text === anchor.exact &&
      samePath(candidate.headingPath, anchor.headingPath) &&
      candidate.prefix === anchor.prefix &&
      candidate.suffix === anchor.suffix,
  );

  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match) {
    return {
      outcome: 'failed',
      reason: matches.length ? '这一页上有好几处一模一样的话，不敢乱跳。' : '这段原文已经找不到了。',
    };
  }
  highlight(match.element);
  return { outcome: 'relocated' };
}

/** 页面身份与内容版本是否仍然一致；用于写回前判定迟到结果。 */
export function currentIdentity(): { url: string; fingerprint: string } {
  return { url: location.href, fingerprint: documentFingerprint() };
}
