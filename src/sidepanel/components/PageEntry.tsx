import type { PageEntryId } from '../page-entry';
import { pageEntryLabel } from '../page-entry';
import { Icon } from './Icon';

/**
 * 还没读这一页时的入口。三个按钮都是同一次明确开始：
 * 总结和问题会一起出来；「让它问我」读完后切到 AI 问。
 */
export function PageEntry({
  pageTitle,
  phase,
  outboundConfirmed,
  busy,
  askHost,
  onPick,
  onOpenSettings,
}: {
  pageTitle: string;
  phase: 'PERMISSION_REQUIRED' | 'READY_TO_START' | 'STALE';
  outboundConfirmed: boolean;
  busy: boolean;
  askHost: boolean;
  onPick: (entry: PageEntryId) => void;
  onOpenSettings?: () => void;
}) {
  const entries: PageEntryId[] = ['summary', 'questions', 'learn'];
  return (
    <section className="section">
      <div className="page-entry-heading">
        <div className="page-entry-heading-copy">
          <h2>{phase === 'STALE' ? '换了一页' : '读这一页'}</h2>
          {pageTitle && <p className="page-title">{pageTitle}</p>}
        </div>
        {onOpenSettings && (
          <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="设置" title="设置">
            <Icon name="settings" />
          </button>
        )}
      </div>
      <p>
        点一个，我才读这一页。换页不会自动读。
      </p>
      <div className="composer-actions">
        {entries.map((entry) => (
          <button
            key={entry}
            type="button"
            className={entry === 'summary' ? undefined : 'secondary'}
            disabled={busy}
            onClick={() => onPick(entry)}
          >
            {pageEntryLabel(entry, outboundConfirmed)}
          </button>
        ))}
      </div>
      {askHost && (
        <p className="hint">
          第一次点，浏览器可能会问你是否允许读取打开的网页。允许之后，仍然只在你点这些按钮时才读。
        </p>
      )}
    </section>
  );
}
