/**
 * 可读子树的遍历与克隆。
 *
 * 页面上有两类正文不在 `document.querySelectorAll` 的范围里：
 * - **开放 shadow root**（自定义组件把内容藏在里面）
 * - **同源 iframe 的文档**
 *
 * 只收集它们还不够：Readability 只看得见传给它的那棵树，所以必须先做一个
 * “展开克隆”——把 shadow 内容与同源框架内容内联进副本，否则收集到的候选
 * 在后面按正文匹配时会被整体丢掉。
 *
 * 拿不到的：**关闭的 shadow root**（`shadowRoot` 为 null）与**跨来源 iframe**
 * （`contentDocument` 为 null）。这两类必须如实披露，不能让用户以为读全了。
 */

const CANDIDATE_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,th,td';
/** 嵌套深度上限，防自引用与病态页面。 */
const MAX_DEPTH = 4;
/** 一页里最多读取多少个同源框架，避免把整页广告位都读进来。 */
const MAX_FRAMES = 20;

export type ReadableRoot = Document | ShadowRoot;

export type TreeStats = {
  /** 页面上的 iframe 总数（含跨来源）。 */
  framesFound: number;
  /** 实际读到内容的同源 iframe 数。 */
  framesRead: number;
  /** 读到的开放 shadow root 数。 */
  shadowRootsRead: number;
};

/** iframe 的文档；跨来源时浏览器返回 null，这里统一成 null。 */
function sameOriginDocument(frame: HTMLIFrameElement): Document | null {
  try {
    const doc = frame.contentDocument;
    return doc?.body ? doc : null;
  } catch {
    // 少数情况下访问被拒绝会抛错，按拿不到处理。
    return null;
  }
}

/**
 * 按阅读顺序列出所有可读子树：主文档 → 开放 shadow root → 同源 iframe 文档。
 * 顺序在提取与回跳两处保持一致，否则锚点前缀后缀会对不上。
 */
export function readableRoots(): { roots: ReadableRoot[]; stats: TreeStats } {
  const roots: ReadableRoot[] = [document];
  const stats: TreeStats = { framesFound: 0, framesRead: 0, shadowRootsRead: 0 };
  const seen = new Set<ReadableRoot>([document]);

  const visit = (root: ReadableRoot, depth: number): void => {
    if (depth >= MAX_DEPTH) return;

    for (const element of root.querySelectorAll('*')) {
      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow && !seen.has(shadow)) {
        seen.add(shadow);
        stats.shadowRootsRead += 1;
        roots.push(shadow);
        visit(shadow, depth + 1);
      }
    }

    for (const frame of root.querySelectorAll<HTMLIFrameElement>('iframe')) {
      stats.framesFound += 1;
      if (stats.framesRead >= MAX_FRAMES) continue;
      const doc = sameOriginDocument(frame);
      if (doc && !seen.has(doc)) {
        seen.add(doc);
        stats.framesRead += 1;
        roots.push(doc);
        visit(doc, depth + 1);
      }
    }
  };

  visit(document, 0);
  return { roots, stats };
}

/** 在全部可读子树里按选择器查询（保持 readableRoots 的顺序）。 */
export function queryAllAcrossTrees<T extends Element>(selector: string): T[] {
  const { roots } = readableRoots();
  return roots.flatMap((root) => [...root.querySelectorAll<T>(selector)]);
}

/**
 * 展开克隆：shadow 内容与同源框架内容内联进副本，使 Readability 能看到它们。
 * 图片顺带把最终地址写进副本，供内容版本计算使用（不依赖索引对齐）。
 *
 * `extraDepth` **只统计跨界层数**（进 shadow root / 进 iframe），不限制普通子节点——
 * 早先把它当成整棵树的深度上限，导致第 4 层的段落被克隆成空壳、正文全丢。
 */
export function cloneExpanded(node: Node, extraDepth = 0): Node {
  const copy = node.cloneNode(false);
  const canExpand = extraDepth < MAX_DEPTH;

  if (node instanceof HTMLImageElement) {
    const source = node.currentSrc || node.src || '';
    if (source && copy instanceof Element) copy.setAttribute('src', source);
  }

  if (canExpand && node instanceof HTMLIFrameElement) {
    const doc = sameOriginDocument(node);
    if (doc?.body) {
      // 不能把框架内容塞回 <iframe> 里面：Readability 会把 iframe 整体删除，
      // 内联进去的正文会跟着一起消失（实测：框架内容读到了，块里却没有）。
      // 用片段把内容“提到” iframe 原来的位置，等于把它当作页面自身的一部分。
      const fragment = (node.ownerDocument ?? document).createDocumentFragment();
      for (const child of doc.body.childNodes) {
        fragment.appendChild(cloneExpanded(child, extraDepth + 1));
      }
      return fragment;
    }
  }

  // 同时保留 shadow 内容与 light DOM 子节点：用 slot 投影时两者互补，
  // 组件自己也渲染同样文字的情况很少，重复会在块层面被去重规则兜住。
  if (canExpand && node instanceof Element && node.shadowRoot) {
    for (const child of node.shadowRoot.childNodes) {
      copy.appendChild(cloneExpanded(child, extraDepth + 1));
    }
  }
  for (const child of node.childNodes) {
    copy.appendChild(cloneExpanded(child, extraDepth));
  }
  return copy;
}

export { CANDIDATE_SELECTOR };
