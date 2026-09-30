import { browser } from 'wxt/browser';
import { DIAGRAM_PREFIX, parseDiagramRecord } from '../core/diagram-record';

/** 只清图表记录；来源关闭后已载入的图仍可查看，不触碰聊天会话。 */
export async function cleanupDiagrams(closed: { tabId?: number; windowId?: number }): Promise<void> {
  const stored = await browser.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(DIAGRAM_PREFIX)) continue;
    const record = parseDiagramRecord(value);
    if (!record) continue;
    const sourceClosed = (closed.tabId !== undefined && closed.tabId === record.sourceTabId) ||
      (closed.windowId !== undefined && closed.windowId === record.sourceWindowId);
    const viewerClosed = (closed.tabId !== undefined && closed.tabId === record.viewerTabId) ||
      (closed.windowId !== undefined && closed.windowId === record.viewerWindowId);
    if (!sourceClosed && !viewerClosed) continue;
    await browser.storage.session.remove(key);
  }
}

/** 主动清除文章内容时关闭图表，避免清除后另一个窗口还留有阅读内容。 */
export async function clearDiagramViews(sourceTabId?: number): Promise<void> {
  const stored = await browser.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(DIAGRAM_PREFIX)) continue;
    const record = parseDiagramRecord(value);
    if (sourceTabId !== undefined && record?.sourceTabId !== sourceTabId) continue;
    await browser.storage.session.remove(key);
    if (record?.viewerTabId !== undefined) await browser.tabs.remove(record.viewerTabId).catch(() => {});
  }
}
