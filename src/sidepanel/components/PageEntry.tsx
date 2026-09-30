import type { PageEntryId } from '../page-entry';
import { Icon } from './Icon';

/**
 * 还没读这一页时的入口。一个明确的开始操作。摘要出现后再由用户选择提问模式。
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
        点击后，我才读这一页。换页不会自动读。
      </p>
      <div className="composer-actions">
        <button type="button" disabled={busy} onClick={() => onPick('summary')}>
          {outboundConfirmed ? '开始阅读' : '我确认，开始阅读'}
        </button>
      </div>
      {askHost && (
        <p className="hint">
          点这里可能会请求读取所有 HTTP(S) 网页的可选权限；授权后仍只在点阅读入口时读取正文。若只想授权当前页，可先再点一次工具栏上的知伴图标，然后点阅读入口。
        </p>
      )}
    </section>
  );
}
