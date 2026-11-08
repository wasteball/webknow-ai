import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';

import { describeCompleteness, type Completeness } from '../../core/blocks';
import type { AppError } from '../../core/errors';
import type { Command, Reply } from '../../core/protocol';
import type { AnswerSource } from '../../core/session';
import { BrandMark, Icon } from './Icon';
import { Rich } from './Rich';

/** 来源与判断标签：不只靠颜色表达，颜色只是附加层（NFR-008/FR-036）。 */

const SOURCE_LABEL: Record<AnswerSource, string> = {
  original: '原文里说的',
  supplement: '补充说明',
  example: '打个比方',
  extended: '文章之外的知识',
  unknown: '没法确认',
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
    <nav className="next" aria-label={lead}>
      <p className="next-lead">{lead}</p>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="next-item"
          disabled={disabled}
          onClick={() => onPick(item)}
        >
          <Icon name="arrowTurn" small />
          <span>{item.question}</span>
        </button>
      ))}
    </nav>
  );
}

/** 读取范围：未解析与缺失范围始终可见（FR-007/FR-018）。 */
export function ScopeLine({ completeness, onJump }: {
  completeness: Completeness | null;
  onJump?: (blockId: string) => void;
}) {
  if (!completeness) return null;
  const range = completeness.textRange;
  return <div className="scope-block">
    <p className="scope"><Icon name="file" small />读了：{describeCompleteness(completeness)}</p>
    {range && <details className="scope-details">
      <summary>核对读取范围</summary>
      <p>仅包括当前已加载、被提取的内容。起止位置供核对，不代表尚未加载的部分也已读取。</p>
      <p>开头：{range.first.jumpable === false ? <span>{range.first.text}（无法定位）</span> : <button type="button" className="link" aria-label="回到正文开头" disabled={!onJump} onClick={() => onJump?.(range.first.blockId)}>{range.first.text}</button>}</p>
      <p>结尾：{range.last.jumpable === false ? <span>{range.last.text}（无法定位）</span> : <button type="button" className="link" aria-label="回到正文结尾" disabled={!onJump} onClick={() => onJump?.(range.last.blockId)}>{range.last.text}</button>}</p>
    </details>}
  </div>;
}

export type BannerAction = { label: string; onClick: () => void };

/** 失败：一句人话 + 解决它的按钮（有的话）+ 关闭。 */
export function ErrorBanner({ error, action, onDismiss }: { error: AppError; action?: BannerAction; onDismiss?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <p>
        <Icon name="info" small />
        {error.message}
      </p>
      {(action || onDismiss) && (
        <div className="banner-actions">
          {action && <button type="button" className="small" onClick={action.onClick}>{action.label}</button>}
          {onDismiss && <button type="button" className="link" onClick={onDismiss}>关闭提示</button>}
        </div>
      )}
    </div>
  );
}

export function Notice({ text, action, onDismiss }: { text: string; action?: BannerAction; onDismiss?: () => void }) {
  return (
    <div className="banner banner-info" role="status">
      <p>
        <Icon name="info" small />
        {text}
      </p>
      {(action || onDismiss) && (
        <div className="banner-actions">
          {action && <button type="button" className="small" onClick={action.onClick}>{action.label}</button>}
          {onDismiss && <button type="button" className="link" onClick={onDismiss}>关闭</button>}
        </div>
      )}
    </div>
  );
}

/** 开场卡：这一页的网站、标题、读取范围，以及摘要或开始入口。全界面唯一的“重”元素。 */
export function Opening({ pageUrl, title, badge, children }: {
  pageUrl: string | null;
  title: string;
  badge?: string;
  children?: ReactNode;
}) {
  return (
    <section className="opening" aria-label="这一页">
      {(badge || siteOf(pageUrl)) && <p className="opening-meta">
        {badge && <span className="opening-badge">{badge}</span>}
        <span className="opening-site">{siteOf(pageUrl)}</span>
      </p>}
      {title && <h2 className="opening-title">{title}</h2>}
      {children}
    </section>
  );
}

function siteOf(url: string | null): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

export function Busy({ label, chars, onStop }: { label: string; chars: number; onStop?: () => void }) {
  return (
    <div className="busy" role="status" aria-live="polite">
      <BrandMark size={20} thinking />
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
    if (!onStop || !node?.offsetParent) return;
    node.scrollIntoView({ block: 'end' });
  }, [text, reasoning, onStop]);
  return (
    <article className="msg ai drafting" ref={endRef}>
      <Thinking text={reasoning} />
      {text ? (
        <div className="said">
          <Rich text={text} diagrams={false} />
        </div>
      ) : null}
      <div className="busy" role="status">
        <BrandMark size={20} thinking />
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
 * 引用、输入和底部工具栏共享一条边框，主按钮固定在工具栏右侧。
 * 空闲时这个按钮提交；这一轮还在写时，它变成停止。
 */
export function ComposerField({
  children,
  busy,
  idleLabel,
  idleIcon = 'send',
  onStop,
  context,
  tools,
  submitDisabled = false,
}: {
  children: ReactNode;
  busy: boolean;
  idleLabel: string;
  idleIcon?: 'send' | 'rotate';
  onStop: () => void;
  context?: ReactNode;
  tools?: ReactNode;
  submitDisabled?: boolean;
}) {
  return (
    <div className="composer-field">
      {context && <div className="composer-context">{context}</div>}
      {children}
      <div className="composer-toolbar">
        <div className="composer-tools">{tools}</div>
        {busy ? (
          <button type="button" className="send-btn" aria-label="停止" title="停止生成" onClick={onStop}>
            <Icon name="stop" />
          </button>
        ) : (
          <button type="submit" className="send-btn" aria-label={idleLabel} title={idleLabel} disabled={submitDisabled}>
            <Icon name={idleIcon} />
          </button>
        )}
      </div>
    </div>
  );
}

/** 随内容和侧栏宽度调整高度；达到 CSS 上限后在文字区内滚动。 */
export function ComposerTextarea({ value, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const field = ref.current;
    if (!field || !field.getClientRects().length) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  };
  useLayoutEffect(resize, [value]);
  useEffect(() => {
    const field = ref.current;
    if (!field || typeof ResizeObserver === 'undefined') return;
    let width = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        resize();
      }
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, []);
  return <textarea {...props} ref={ref} value={value} />;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/**
 * 错误边界（二期）：某一条消息渲染出错，只影响这一条，其它对话照常；
 * 包在整个面板外时，至少给一句人话和重新载入，而不是白屏。
 */
export class Guard extends Component<{ children: ReactNode; whole?: boolean }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error('[WebKnow AI] 渲染出错', error);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.whole) {
      return (
        <div className="banner banner-error" role="alert">
          <p><Icon name="info" small />界面出了点问题，你的对话都还在。</p>
          <div className="banner-actions">
            <button type="button" className="small" onClick={() => location.reload()}>重新载入</button>
          </div>
        </div>
      );
    }
    return <p className="aside guard-failed" role="status">这一条没能显示出来，其它对话不受影响。</p>;
  }
}

/**
 * 收藏到知识库（三期）：一次保存 = 这一页的网址 + 整理好的阅读笔记（摘要、问答、学习小结）。
 * 已连接时一点即存；没连接时点它去设置里连接。结果就地显示一句话。
 */
export function SaveButton({ connected, kbName, tabId, send, onConnect, disabled }: {
  connected: boolean;
  kbName: string | null;
  tabId: number | null;
  send: (command: Command) => Promise<Reply | undefined>;
  onConnect?: () => void;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!connected || !kbName) { onConnect?.(); return; }
    if (tabId === null || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      const reply = await send({ type: 'saveToIma', tabId });
      setStatus(reply?.ok ? { ok: true, text: reply.message ?? `已存到「${kbName}」。` }
        : { ok: false, text: reply && !reply.ok ? reply.error.message : '没有存成，可以再试一次。' });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="save-row">
      <button type="button" className="save-btn" disabled={disabled || saving} onClick={() => void save()}
        title={connected && kbName ? `把这一页和阅读笔记存到「${kbName}」` : '先连接知识库'}>
        <Icon name="shelf" small />
        {saving ? '正在存…' : connected && kbName ? '收藏到知识库' : '连接知识库后收藏'}
      </button>
      {status && <span className={status.ok ? 'save-done' : 'save-failed'} role="status">
        {status.ok && <Icon name="check" small />}{status.text}
      </span>}
    </div>
  );
}
