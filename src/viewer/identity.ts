import { browser } from 'wxt/browser';
import { matchesDiagramViewer, type DiagramRecord } from '../core/diagram-record';

export const DIAGRAM_IDENTITY_MESSAGE = 'webknow:diagramIdentity';

/** tab ID 会随导航保留；操作标签前还须核对正在显示的自家文档。 */
export async function isCurrentDiagramViewer(record: DiagramRecord): Promise<boolean> {
  if (record.viewerTabId === undefined) return false;
  try {
    const tab = await browser.tabs.get(record.viewerTabId);
    if (tab.windowId !== record.viewerWindowId || tab.status === 'loading') return false;
    const ownUrl = browser.runtime.getURL('/viewer.html');
    const visibleUrl = tab.pendingUrl ?? tab.url;
    if (visibleUrl) return matchesDiagramViewer(record, tab, visibleUrl, ownUrl);

    // 没有 tabs 权限时，自家扩展标签的 URL 也可能不返回。
    // MV3 worker 没有 extension.getViews，Chrome 116+ 用自己的文档上下文核对。
    if (typeof browser.runtime.getContexts === 'function') {
      const contexts = await browser.runtime.getContexts({ tabIds: [record.viewerTabId], frameIds: [0] });
      return contexts.some((context) => context.tabId === tab.id && context.windowId === tab.windowId &&
        typeof context.documentUrl === 'string' && matchesDiagramViewer(record, tab, context.documentUrl, ownUrl));
    }
    // 保留 Chrome 114/115 支持：只有目标查看器会回应，普通网页没有这个入口。
    const identity = await browser.runtime.sendMessage({ type: DIAGRAM_IDENTITY_MESSAGE, tabId: tab.id, id: record.id }) as
      { tab?: { id?: number; windowId: number }; url?: string } | undefined;
    return Boolean(identity?.tab && typeof identity.url === 'string' && matchesDiagramViewer(record, identity.tab, identity.url, ownUrl));
  } catch { return false; }
}
