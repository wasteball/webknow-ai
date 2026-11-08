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
  // 标题与网站名由外层开场卡显示；这里只放说明和唯一的主操作。
  void pageTitle; void onOpenSettings;
  return (
    <div className="opening-entry">
      <p>
        {phase === 'STALE' ? '换了一页。点一下，我再读这一页。' : '我先读一遍，给你一段摘要和几个值得问的问题。'}
      </p>
      <button type="button" className="block" disabled={busy} onClick={() => onPick('summary')}>
        <Icon name="play" small />
        {outboundConfirmed ? '开始阅读' : '我确认，开始阅读'}
      </button>
      <p className="hint opening-promise">点了才读，换页不会自动读。</p>
      {askHost && (
        <p className="hint">
          点这里可能会请求读取所有网页的可选权限；授权后仍只在你点开始阅读时才读正文。只想授权当前页的话，先再点一次工具栏上的 WebKnow AI 图标，再点开始阅读。
        </p>
      )}
    </div>
  );
}
