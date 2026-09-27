import type { ReactNode } from 'react';

import type { Completeness } from '../../core/blocks';
import type { AppError } from '../../core/errors';
import type { AnswerSource, Verdict } from '../../core/session';
import { Icon } from './Icon';

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
  if (completeness.images.found > 0) parts.push(`${completeness.images.found} 张图片没读`);
  const framesUnread = completeness.frames.found - completeness.frames.captured;
  if (framesUnread > 0) parts.push(`${framesUnread} 个内嵌页面没读`);
  if (completeness.excludedBlocks > 0) parts.push(`${completeness.excludedBlocks} 段没法定位，没算进去`);
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

export function Busy({ label, chars, onStop }: { label: string; chars: number; onStop: () => void }) {
  return (
    <div className="busy" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>
        {label}
        {chars > 0 ? `（已生成约 ${chars} 字）` : '…'}
      </span>
      <button type="button" onClick={onStop}>
        停止
      </button>
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
