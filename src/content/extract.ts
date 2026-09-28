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
  PictureRef,
} from '../core/blocks';
import { appError } from '../core/errors';
import { LIMITS } from '../core/limits';
import { contentImageUrl, isContentImage } from './pictures';
import { pageKey } from '../core/page-drift';
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

/** 公众号页脚、分享条，不是正文。 */
const PAGE_CHROME = /微信扫一扫|关注(?:该)?公众号|阅读原文|点击上方|长按识别/;

function minCharsFor(element: Element): number {
  // 微信常把小节标题写成很短的 p。「为什么会产生这种文化」只有十个字，20 字门槛会整段丢掉。
  return element.matches('p') ? 8 : 2;
}

function candidateText(element: Element): string | null {
  if (element.closest('[aria-hidden="true"]')) return null;
  const text = normalizeText(element.textContent);
  if (text.length < minCharsFor(element)) return null;
  if (PAGE_CHROME.test(text)) return null;
  return text;
}

const LEAF_SELECTOR = 'section,blockquote,figcaption';

/** 真正有字的节点。空段落、短到入选门槛以下的节点不算“发现了但没读”。 */
function orderedTextNodes(scope: ParentNode): HTMLElement[] {
  const primary = [...scope.querySelectorAll<HTMLElement>(CANDIDATES)].filter((element) => candidateText(element));
  const leaves = [...scope.querySelectorAll<HTMLElement>(LEAF_SELECTOR)].filter((element) => {
    if (element.querySelector(CANDIDATES) || element.querySelector(LEAF_SELECTOR)) return false;
    return candidateText(element) !== null;
  });
  const all = [...primary, ...leaves];
  all.sort((left, right) => {
    if (left === right) return 0;
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return all;
}

/**
 * 微信正文在揭开之前是 visibility:hidden。Readability 会把整段丢掉。
 * 这种页直接走 #js_content，不看那层隐藏样式。
 */
function directArticleRoot(): HTMLElement | null {
  const node = document.querySelector('#js_content') ?? document.querySelector('.rich_media_content');
  if (!(node instanceof HTMLElement)) return null;
  const enoughText = normalizeText(node.textContent).length >= LIMITS.minArticleChars;
  const enoughImages = [...node.querySelectorAll('img')].some((image) => isContentImage(image));
  if (!enoughText && !enoughImages) return null;
  return node;
}

function contentImages(scope: ParentNode): HTMLImageElement[] {
  return [...scope.querySelectorAll('img')].filter((image) => isContentImage(image));
}

function annotateSource(runId: string): SourceCandidate[] {
  clearAnchors();
  const { roots } = readableRoots();
  // 按子树顺序拉平：编号、前后缀、标题路径都基于同一份顺序，提取与回跳必须一致。
  const found = roots.flatMap((root) => {
    const scope: ParentNode = root instanceof Document ? (root.body ?? root) : root;
    return orderedTextNodes(scope).map((element) => ({ element, root }));
  });
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

function parseArticle(doc: Document) {
  return new Readability(doc).parse();
}

type ReadPieces = {
  title: string;
  texts: string[];
  imageUrls: string[];
  direct: HTMLElement | null;
};

/** 提取和指纹共用这一份正文与图片地址，避免“读到的”和“用来判断改没改过”不是同一篇。 */
function readPieces(): ReadPieces {
  const direct = directArticleRoot();
  if (direct) {
    return {
      title: normalizeText(document.querySelector('#activity-name')?.textContent) || document.title,
      texts: orderedTextNodes(direct).map((element) => candidateText(element) ?? ''),
      imageUrls: contentImages(direct).map((image) => contentImageUrl(image)),
      direct,
    };
  }
  const clone = cloneExpanded(document) as Document;
  const article = parseArticle(clone);
  if (!article?.content) {
    return { title: document.title, texts: [], imageUrls: [], direct: null };
  }
  const root = new DOMParser().parseFromString(`<main>${article.content}</main>`, 'text/html').body;
  return {
    title: article.title || document.title,
    texts: orderedTextNodes(root).map((element) => candidateText(element) ?? ''),
    imageUrls: contentImages(root).map((image) => contentImageUrl(image)),
    direct: null,
  };
}

/** 同一地址下正文或图片变了，这个指纹就变。转述文字不进指纹，免得每次读图都像改过稿。 */
export function documentFingerprint(): string {
  const pieces = readPieces();
  const key = pageKey(location.href);
  if (!pieces.texts.length && !pieces.imageUrls.length) {
    return fingerprint(`${key}\n${document.title}\nunreadable`);
  }
  return fingerprint(`${key}\n${document.title}\n${pieces.texts.join('\n')}\n${pieces.imageUrls.join('\n')}`);
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
 * 取而代之：只在页面上真的存在“展开全文/加载更多”这类入口时如实披露。
 * 用户自己点开或改完再发布后，下一次提问会按当时的正文来回答。
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

function liveBlock(element: HTMLElement, root: Element, index: number, runId: string, nodes: HTMLElement[]): EvidenceBlock {
  const text = candidateText(element) ?? '';
  const anchorId = `wka-${runId}-${index.toString(36)}`;
  element.setAttribute(ANCHOR_ATTRIBUTE, anchorId);
  const headingPath = headingPathAtFrom(root, element);
  return {
    id: `b_${index.toString(36)}`,
    role: roleOf(element),
    content: text,
    headingPath,
    table: tableContext(element),
    anchor: {
      sessionAnchorId: anchorId,
      selector: cssPath(element),
      exact: text,
      prefix: normalizeText(nodes[index - 1]?.textContent).slice(-100),
      suffix: normalizeText(nodes[index + 1]?.textContent).slice(0, 100),
      headingPath,
      fingerprint: fingerprint(`${text}\n${headingPath.join(' > ')}`),
    },
  };
}

/** 对不上唯一位置时仍保留文字。跳转可能失败，这比把段落丢掉要好。 */
function looseBlock(content: string, element: Element, headingPath: string[], index: number): EvidenceBlock {
  return {
    id: `b_${index.toString(36)}`,
    role: roleOf(element),
    content,
    headingPath,
    table: tableContext(element),
    anchor: {
      sessionAnchorId: '',
      selector: '',
      exact: content,
      prefix: '',
      suffix: '',
      headingPath,
      fingerprint: fingerprint(`${content}\n${headingPath.join(' > ')}`),
    },
  };
}

function titleBlock(title: string): EvidenceBlock {
  const text = normalizeText(title) || '这一页主要是图片';
  return {
    id: 'b_title',
    role: 'heading',
    content: text,
    headingPath: [],
    anchor: {
      sessionAnchorId: '',
      selector: '',
      exact: text,
      prefix: '',
      suffix: '',
      headingPath: [],
      fingerprint: fingerprint(text),
    },
  };
}

function assignPictures(
  images: HTMLImageElement[],
  blockElements: (HTMLElement | null)[],
  blocks: EvidenceBlock[],
  runId: string,
): PictureRef[] {
  return images.slice(0, LIMITS.maxImages).map((image, index) => {
    const url = contentImageUrl(image);
    const anchorId = `wka-${runId}-i${index.toString(36)}`;
    if (image.isConnected) image.setAttribute(ANCHOR_ATTRIBUTE, anchorId);
    let afterBlockId: string | undefined;
    for (let cursor = 0; cursor < blockElements.length; cursor += 1) {
      const element = blockElements[cursor];
      if (!element?.isConnected) continue;
      if (element.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING) {
        afterBlockId = blocks[cursor]?.id;
      }
    }
    const alt = normalizeText(image.getAttribute('alt')).slice(0, 120);
    const exact = `image:${(alt || url).slice(0, 80)}`;
    return {
      id: `img_${index}`,
      url,
      alt,
      afterBlockId,
      anchor: {
        sessionAnchorId: image.isConnected ? anchorId : '',
        selector: image.isConnected ? cssPath(image) : '',
        exact,
        prefix: '',
        suffix: '',
        headingPath: [],
        fingerprint: fingerprint(`image:${url}`),
      },
    };
  });
}

function liveImagesFor(urls: string[]): HTMLImageElement[] {
  const wanted = new Set(urls);
  const byUrl = new Map<string, HTMLImageElement>();
  for (const image of queryAllAcrossTrees<HTMLImageElement>('img')) {
    const url = contentImageUrl(image);
    if (wanted.has(url) && !byUrl.has(url)) byUrl.set(url, image);
  }
  return urls.flatMap((url) => {
    const image = byUrl.get(url);
    return image ? [image] : [];
  });
}

export function extractDocument(): BlocksPayload {
  const contentType = document.contentType ?? 'text/html';
  if (!contentType.includes('html')) {
    throw appError('PAGE_UNSUPPORTED', '这一页不是普通的网页文章（可能是文件或特殊页面），现在读不了。');
  }

  const runId = Math.random().toString(36).slice(2, 8);
  const { stats } = readableRoots();
  const direct = directArticleRoot();

  let excludedBlocks = 0;
  let blocks: EvidenceBlock[] = [];
  let blockElements: (HTMLElement | null)[] = [];
  let textNodes: HTMLElement[] = [];
  let usedFallback = false;
  let imageUrls: string[] = [];
  let liveImages: HTMLImageElement[] = [];
  let title = document.title;
  let sawArticle = false;

  if (direct) {
    clearAnchors();
    title = normalizeText(document.querySelector('#activity-name')?.textContent) || document.title;
    textNodes = orderedTextNodes(direct);
    blocks = textNodes.map((element, index) => liveBlock(element, direct, index, runId, textNodes));
    blockElements = textNodes;
    liveImages = contentImages(direct);
    imageUrls = liveImages.map((image) => contentImageUrl(image));
    sawArticle = true;
  } else {
    const source = annotateSource(runId);
    const byId = new Map(source.map((candidate) => [candidate.id, candidate]));
    const clone = cloneExpanded(document) as Document;
    const article = parseArticle(clone);
    sawArticle = Boolean(article?.content);
    title = article?.title || document.title;

    if (article?.content) {
      const root = new DOMParser().parseFromString(`<main>${article.content}</main>`, 'text/html').body;
      textNodes = orderedTextNodes(root);
      imageUrls = contentImages(root).map((image) => contentImageUrl(image));
      for (const element of textNodes) {
        const content = candidateText(element);
        if (!content) continue;
        const retainedId = element.getAttribute(ANCHOR_ATTRIBUTE);
        let match = retainedId ? byId.get(retainedId) : undefined;
        if (!match || match.text !== content) {
          const path = headingPathAtFrom(root, element);
          const candidates = source.filter(
            (candidate) => candidate.text === content && samePath(candidate.headingPath, path),
          );
          match = candidates.length === 1 ? candidates[0] : undefined;
        }
        if (!match) {
          excludedBlocks += 1;
          blocks.push(looseBlock(content, element, headingPathAtFrom(root, element), blocks.length));
          blockElements.push(null);
          continue;
        }
        blocks.push(blockFromCandidate({ ...match, text: content }, blocks.length));
        blockElements.push(match.element);
      }
    }

    if (!enoughContent(blocks)) {
      const fallback = source.map((candidate, index) => blockFromCandidate(candidate, index));
      if (enoughContent(fallback)) {
        blocks = fallback;
        blockElements = source.map((candidate) => candidate.element);
        textNodes = source.map((candidate) => candidate.element);
        excludedBlocks = 0;
        usedFallback = true;
        if (!imageUrls.length) {
          imageUrls = contentImages(document.body ?? document).map((image) => contentImageUrl(image));
        }
      } else if (!imageUrls.length) {
        imageUrls = contentImages(document.body ?? document).map((image) => contentImageUrl(image));
      }
    }
    liveImages = liveImagesFor(imageUrls);
  }

  if (!enoughContent(blocks) && liveImages.length === 0 && imageUrls.length === 0) {
    clearAnchors();
    throw appError(
      'EXTRACT_FAILED',
      sawArticle
        ? '这一页的文字太少，凑不出完整的内容。换一篇正常文章试试。'
        : '这一页找不到成篇的文字。目前只支持文章类网页；列表页、搜索结果和复杂的网页应用读不了。',
    );
  }
  if (!blocks.length) blocks = [titleBlock(title)];

  const pictures = assignPictures(liveImages, blockElements, blocks, runId);
  const textFound = textNodes.filter((element) => !element.matches('th,td')).length;
  const tableFound = textNodes.filter((element) => element.matches('th,td')).length;
  const textCaptured = blocks.filter((block) => block.role !== 'table-cell' && block.role !== 'image').length;
  const tableCaptured = blocks.filter((block) => block.role === 'table-cell').length;
  const imageFound = imageUrls.length;

  const warnings: string[] = [];
  const hints = detectUnloadedHints();
  if (hints.length) {
    warnings.push(`页面上有「${hints.join('、')}」，可能还有没展开的内容没有读到。`);
  }
  if (usedFallback) warnings.push('这一页不太像完整文章，按页面上的文字块读取。');

  const completeness: Completeness = {
    scope: 'readability-article',
    text: coverage(
      textCaptured < textFound ? 'partial' : textFound === 0 && textCaptured === 0 ? 'not-present' : 'parsed',
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

  clearAnchors(
    new Set(
      [...blocks.map((block) => block.anchor.sessionAnchorId), ...pictures.map((picture) => picture.anchor.sessionAnchorId)].filter(
        (id) => id.length > 0,
      ),
    ),
  );
  return {
    title,
    url: location.href,
    fingerprint: documentFingerprint(),
    blocks,
    completeness,
    pictures,
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
  const articleRoot = directArticleRoot();
  if (articleRoot) {
    const nodes = orderedTextNodes(articleRoot);
    return nodes.map((element, index) => ({
      element,
      id: element.getAttribute(ANCHOR_ATTRIBUTE) ?? '',
      text: normalizeText(element.textContent),
      headingPath: headingPathAtFrom(articleRoot, element),
      selector: cssPath(element),
      prefix: normalizeText(nodes[index - 1]?.textContent).slice(-100),
      suffix: normalizeText(nodes[index + 1]?.textContent).slice(0, 100),
    }));
  }
  const { roots } = readableRoots();
  const found = roots.flatMap((root) =>
    orderedTextNodes(root)
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
  const articleRoot = directArticleRoot();
  const { roots } = readableRoots();
  const directMatches = roots.flatMap((root) =>
    [...root.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTRIBUTE}="${escapeCss(anchor.sessionAnchorId)}"]`)].map(
      (element) => ({ element, root }),
    ),
  );
  const direct = directMatches.length === 1 ? directMatches[0] : undefined;
  if (direct && anchor.exact.startsWith('image:') && direct.element instanceof HTMLImageElement) {
    highlight(direct.element);
    return { outcome: 'jumped' };
  }
  if (
    direct &&
    normalizeText(direct.element.textContent) === anchor.exact &&
    fingerprint(
      `${normalizeText(direct.element.textContent)}\n${(
        articleRoot?.contains(direct.element)
          ? headingPathAtFrom(articleRoot, direct.element)
          : headingPathIn(direct.root, direct.element)
      ).join(' > ')}`,
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

/** 当前页的地址和正文指纹。后台用它区分改稿、换页，以及读不到页面。 */
export function currentIdentity(): { url: string; fingerprint: string } {
  return { url: location.href, fingerprint: documentFingerprint() };
}
