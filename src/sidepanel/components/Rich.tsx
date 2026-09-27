import { lazy, Suspense, useMemo, type ReactNode } from 'react';

import { parseMarkdown, type Block, type Inline } from '../../core/markdown';

/**
 * AST → React 元素。这里是唯一把模型文本变成界面的地方。
 *
 * 安全性来自结构，不来自过滤：整个文件没有 dangerouslySetInnerHTML、没有 innerHTML、
 * 没有 HTML 字符串拼接。解析器只产出白名单节点，每个节点映射到一个固定标签，
 * 文本一律走 React 的自动转义（FR-037）。
 */

// 图表渲染器（含 mermaid）只在真的出现图表时加载，不进主包。
const Diagram = lazy(() => import('./Diagram').then((module) => ({ default: module.Diagram })));

/** 图片 id → 当前页真实 src。只认这张表里的 id，其余一律不渲染（见方案 2.4）。 */
export type ImageResolver = (id: string) => { src: string; alt: string; blockId?: string } | undefined;

type RichProps = {
  text: string;
  /** 用户设置「不要图」时传 false。 */
  diagrams?: boolean;
  images?: ImageResolver;
  /** 点击原文图片时回跳到原文位置。 */
  onImageClick?: (blockId: string) => void;
};

export function Rich({ text, diagrams = true, images, onImageClick }: RichProps) {
  const blocks = useMemo(() => parseMarkdown(text, { diagrams }), [text, diagrams]);
  return <Blocks blocks={blocks} images={images} onImageClick={onImageClick} />;
}

function Blocks({
  blocks,
  images,
  onImageClick,
}: {
  blocks: Block[];
  images?: ImageResolver;
  onImageClick?: (blockId: string) => void;
}) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} images={images} onImageClick={onImageClick} />
      ))}
    </>
  );
}

function BlockView({
  block,
  images,
  onImageClick,
}: {
  block: Block;
  images?: ImageResolver;
  onImageClick?: (blockId: string) => void;
}) {
  const inline = (nodes: Inline[]) => <Inlines nodes={nodes} images={images} onImageClick={onImageClick} />;

  switch (block.t) {
    case 'p':
      return <p className="rich-p">{inline(block.v)}</p>;
    case 'h':
      return block.level === 3 ? (
        <h3 className="rich-h3">{inline(block.v)}</h3>
      ) : (
        <h4 className="rich-h4">{inline(block.v)}</h4>
      );
    case 'ul':
      return (
        <ul className="rich-ul">
          {block.items.map((item, index) => (
            <li key={index}>
              {inline(item.v)}
              {item.sub && <Blocks blocks={item.sub} images={images} onImageClick={onImageClick} />}
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="rich-ol">
          {block.items.map((item, index) => (
            <li key={index}>
              {inline(item.v)}
              {item.sub && <Blocks blocks={item.sub} images={images} onImageClick={onImageClick} />}
            </li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote className="rich-quote">
          <Blocks blocks={block.v} images={images} onImageClick={onImageClick} />
        </blockquote>
      );
    case 'code':
      return (
        <pre className="rich-code">
          <code>{block.v}</code>
        </pre>
      );
    case 'table':
      return (
        <div className="rich-table-scroll">
          <table className="rich-table">
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{inline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'diagram':
      return (
        <Suspense fallback={<div className="diagram-loading">正在画图…</div>}>
          <Diagram source={block.source} />
        </Suspense>
      );
    case 'diagram-raw':
      // 越界或渲染不了的图必须如实说明，不静默消失（FR-018 的同一条纪律）。
      return (
        <figure className="diagram-failed">
          <pre className="rich-code">
            <code>{block.source}</code>
          </pre>
          <figcaption>{block.reason}</figcaption>
        </figure>
      );
  }
}

function Inlines({
  nodes,
  images,
  onImageClick,
}: {
  nodes: Inline[];
  images?: ImageResolver;
  onImageClick?: (blockId: string) => void;
}) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.t) {
          case 'text':
            return node.v;
          case 'strong':
            return <strong key={index}>{node.v}</strong>;
          case 'code':
            return (
              <code key={index} className="rich-inline-code">
                {node.v}
              </code>
            );
          case 'img': {
            const found = images?.(node.id);
            // 查不到就整个丢弃：模型引用了不存在的图片，不留破图也不留占位。
            if (!found) return null;
            const jump = found.blockId;
            const picture = <img src={found.src} alt={found.alt || node.alt} loading="lazy" />;
            return jump && onImageClick ? (
              <button
                key={index}
                type="button"
                className="rich-img"
                onClick={() => onImageClick(jump)}
                title="回到原文里这张图的位置"
              >
                {picture}
              </button>
            ) : (
              <span key={index} className="rich-img">
                {picture}
              </span>
            );
          }
        }
      })}
    </>
  );
}

/** 纯文本场景（题干、选项）：只解析行内，不产生块级元素。 */
export function RichInline({ text }: { text: string }): ReactNode {
  const nodes = useMemo(() => parseMarkdown(text, { diagrams: false }), [text]);
  const flat = nodes.flatMap((block) => (block.t === 'p' || block.t === 'h' ? block.v : [{ t: 'text' as const, v: '' }]));
  return <Inlines nodes={flat} />;
}
