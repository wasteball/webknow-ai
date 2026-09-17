import type { ReactNode } from 'react';

import type { Completeness } from '../../core/blocks';
import type { AppError } from '../../core/errors';
import type { AnswerSource, Verdict } from '../../core/session';

/** 来源与判断标签：不只靠颜色表达，颜色只是附加层（NFR-008/FR-036）。 */

const SOURCE_LABEL: Record<AnswerSource, string> = {
  original: '原文依据',
  supplement: '补充解释',
  example: '假设例子',
  extended: '延伸知识',
  unknown: '当前无法确认',
};

const VERDICT_LABEL: Record<Verdict, string> = {
  correct: '基本正确',
  partial: '部分正确',
  misconception: '明显误解',
  unknown: '不知道或需要讲解',
  objection: '合理异议',
};

export function SourceTag({ source }: { source: AnswerSource }) {
  return <span className={`tag tag-${source}`}>{SOURCE_LABEL[source]}</span>;
}

export function VerdictTag({ verdict }: { verdict: Verdict }) {
  return <span className={`tag tag-${verdict}`}>{VERDICT_LABEL[verdict]}</span>;
}

/** 读取范围：未解析与缺失范围始终可见（FR-007/FR-018）。 */
export function ScopeLine({ completeness }: { completeness: Completeness | null }) {
  if (!completeness) return null;
  const parts = [`已读取正文块 ${completeness.text.captured} 个`];
  if (completeness.text.status === 'partial') parts.push('正文只读取了一部分');
  if (completeness.tables.found > 0) {
    parts.push(
      completeness.tables.status === 'parsed'
        ? `表格单元格 ${completeness.tables.captured} 个`
        : `表格只读取了 ${completeness.tables.captured}/${completeness.tables.found} 个单元格`,
    );
  }
  if (completeness.images.found > 0) parts.push(`${completeness.images.found} 张图片未解析`);
  if (completeness.excludedBlocks > 0) parts.push(`${completeness.excludedBlocks} 个正文块未能定位`);
  if (completeness.truncated) parts.push('未覆盖全文');
  return <p className="scope">读取范围：{parts.join('；')}</p>;
}

export function ErrorBanner({ error, onDismiss }: { error: AppError; onDismiss?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <p>{error.message}</p>
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
      <p>{text}</p>
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
