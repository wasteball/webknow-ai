import { useEffect, useRef, type ReactNode } from 'react';

import type { Completeness } from '../../core/blocks';
import type { AppError } from '../../core/errors';
import type { AnswerSource, Verdict } from '../../core/session';
import { Icon } from './Icon';
import { Rich } from './Rich';

/** 来源与判断标签：不只靠颜色表达，颜色只是附加层（NFR-008/FR-036）。 */

const SOURCE_LABEL: Record<AnswerSource, string> = {
  original: '原文里说的',
  supplement: '补充说明',
  example: '打个比方',
  extended: '文章之外的知识',
  unknown: '没法确认',
};

const VERDICT_LABEL: Record<Verdict, string> = {
  correct: '答得不错',
  partial: '对了一半',
  misconception: '理解偏了',
  unknown: '没答上来',
  objection: '你的质疑有道理',
};

/**
 * 来源标签只在「不是默认情况」时出现。
 * 绝大多数回答都来自原文，每一条都挂一枚「原文里说的」等于没有信息，
 * 只是噪音；真正需要提醒的是「这句不是文章里的」。异常才标记。
 */
export function SourceTag({ source }: { source: AnswerSource }) {
  if (source === 'original') return null;
  return <span className={`tag tag-${source}`}>{SOURCE_LABEL[source]}</span>;
}

/**
 * 快捷选项：两个模式共用同一排卡片（开场话题、追问方向、下一轮方向）。
 * 中性淡灰卡片，不写「发出去」——卡片本身就是按钮，多一枚徽章只是重复。
 */
export function SuggestRow({
  lead,
  items,
  disabled,
  onPick,
}: {
  lead: string;
  items: { id: string; question: string }[];
  disabled?: boolean;
  onPick: (item: { id: string; question: string }) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="chiprow">
      <p className="chip-lead">{lead}</p>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="chip"
          disabled={disabled}
          onClick={() => onPick(item)}
        >
          {item.question}
        </button>
      ))}
    </div>
  );
}

export function VerdictTag({ verdict }: { verdict: Verdict }) {
  return <span className={`tag tag-${verdict}`}>{VERDICT_LABEL[verdict]}</span>;
}

/** 读取范围：未解析与缺失范围始终可见（FR-007/FR-018）。 */
export function ScopeLine({ completeness }: { completeness: Completeness | null }) {
  if (!completeness) return null;
  const parts = [`读到了 ${completeness.text.captured} 段文字`];
  if (completeness.text.status === 'partial') parts.push('正文只读到一部分');
  if (completeness.tables.found > 0) {
    parts.push(
      completeness.tables.status === 'parsed'
        ? `表格 ${completeness.tables.captured} 格`
        : `表格只读到 ${completeness.tables.captured}/${completeness.tables.found} 格`,
    );
  }
  if (completeness.images.found > 0) {
    const { found, captured } = completeness.images;
    if (captured > 0) {
      parts.push(`读了 ${captured} 张图（模型转述，可能有误）`);
      if (found > captured) parts.push(`还有 ${found - captured} 张没读`);
    } else if (completeness.warnings.some((warning) => warning.includes('读不了图') || warning.includes('没读到'))) {
      parts.push(`${found} 张图片没读`);
    } else {
      parts.push(`${found} 张图片还没读`);
    }
  }
  const framesUnread = completeness.frames.found - completeness.frames.captured;
  if (framesUnread > 0) parts.push(`${framesUnread} 个内嵌页面没读`);
  if (completeness.excludedBlocks > 0) parts.push(`${completeness.excludedBlocks} 处读到了，但没法点回原文`);
  if (completeness.truncated) parts.push('没有读完整篇');
  // 未展开的内容、无法定位的块等，都在这里如实告诉用户。
  parts.push(...completeness.warnings);
  return (
    <p className="scope">
      <Icon name="file" small />
      读取范围：{parts.join('；')}
    </p>
  );
}

export function ErrorBanner({ error, onDismiss }: { error: AppError; onDismiss?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <p>
        <Icon name="info" small />
        {error.message}
      </p>
      {onDismiss && (
        <button type="button" className="link" onClick={onDismiss}>
          关闭提示
        </button>
      )}
    </div>
  );
}

export function Notice({ text, onDismiss }: { text: string; onDismiss?: () => void }) {
  return (
    <div className="banner banner-info" role="status">
      <p>
        <Icon name="info" small />
        {text}
      </p>
      {onDismiss && (
        <button type="button" className="link" onClick={onDismiss}>
          关闭
        </button>
      )}
    </div>
  );
}

export function Busy({ label, chars, onStop }: { label: string; chars: number; onStop?: () => void }) {
  return (
    <div className="busy" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>
        {label}
        {chars > 0 ? `（已生成约 ${chars} 字）` : '…'}
      </span>
      {onStop && (
        <button type="button" onClick={onStop}>
          停止
        </button>
      )}
    </div>
  );
}

/** 有思考过程才出现。默认合上，点标题展开，再点合上。正文仍走原来的渲染。 */
export function Thinking({ text }: { text: string }) {
  const body = text.trim();
  if (!body) return null;
  return (
    <details className="thinking">
      <summary>思考过程</summary>
      <div className="thinking-body">{body}</div>
    </details>
  );
}

/** 正在写的正文。图表等这一段闭合后再画，半截 mermaid 不进渲染。 */
export function Drafting({
  text,
  reasoning = '',
  onStop,
}: {
  text: string;
  reasoning?: string;
  /** 还没有输入框的阶段（首屏）才把停止放在正文下。对话里停止在输入框内。 */
  onStop?: () => void;
}) {
  const endRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = endRef.current;
    if (!node?.offsetParent) return;
    node.scrollIntoView({ block: 'end' });
  }, [text, reasoning]);
  return (
    <article className="msg ai drafting" ref={endRef}>
      <Thinking text={reasoning} />
      {text ? (
        <div className="said">
          <Rich text={text} diagrams={false} />
        </div>
      ) : null}
      <div className="busy" role="status">
        <span className="spinner" aria-hidden="true" />
        <span className="sr-only">正在写下这段</span>
        {onStop && (
          <button type="button" onClick={onStop}>
            停止
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * 输入框和右下角的主按钮包在同一条边框里。
 * 空闲时这个按钮提交；这一轮还在写时，它变成停止。
 */
export function ComposerField({
  children,
  busy,
  idleLabel,
  idleIcon = 'send',
  onStop,
}: {
  children: ReactNode;
  busy: boolean;
  idleLabel: string;
  idleIcon?: 'send' | 'rotate';
  onStop: () => void;
}) {
  return (
    <div className="composer-field">
      {children}
      {busy ? (
        <button type="button" className="send-btn" aria-label="停止" onClick={onStop}>
          <Icon name="stop" small />
        </button>
      ) : (
        <button type="submit" className="send-btn" aria-label={idleLabel}>
          <Icon name={idleIcon} small />
        </button>
      )}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
