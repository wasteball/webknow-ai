import { browser } from 'wxt/browser';
import { diagramKey, DIAGRAM_PREFIX, parseDiagramRecord, type DiagramDraft, type DiagramRecord } from '../core/diagram-record';
import { waitForTabReady } from './tab-ready';
import { isCurrentDiagramViewer } from '../viewer/identity';

const opening = new Map<string, Promise<DiagramRecord>>();

/** 重复点击只聚焦；先写记录，后创建视图，避免页面加载与传输的时序竞争。 */
export function openDiagram(draft: DiagramDraft): Promise<DiagramRecord> {
  const signature = `${draft.sourceTabId}:${draft.svg}`;
  const pending = opening.get(signature);
  if (pending) return pending;
  const work = open(draft).finally(() => opening.delete(signature));
  opening.set(signature, work);
  return work;
}

async function open(draft: DiagramDraft): Promise<DiagramRecord> {
  const source = await browser.tabs.get(draft.sourceTabId);
  if (source.windowId !== draft.sourceWindowId) throw new Error('来源文章已关闭');
  const stored = await browser.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(DIAGRAM_PREFIX)) continue;
    const record = parseDiagramRecord(value);
    if (!record || record.sourceTabId !== draft.sourceTabId || record.svg !== draft.svg || record.viewerTabId === undefined) continue;
    try {
      if (!await isCurrentDiagramViewer(record)) {
        await browser.storage.session.remove(key);
        continue;
      }
      await browser.tabs.update(record.viewerTabId, { active: true });
      await browser.windows.update(record.viewerWindowId!, { focused: true });
      return record;
    } catch { await browser.storage.session.remove(key); }
  }

  let record: DiagramRecord = { ...draft, id: crypto.randomUUID(), createdAt: Date.now() };
  const key = diagramKey(record.id);
  const url = `${browser.runtime.getURL('/viewer.html')}?diagram=${record.id}`;
  await browser.storage.session.set({ [key]: record });
  let viewerTabId: number | undefined;
  try {
    try {
      const window = await browser.windows.create({ url, type: 'popup', state: 'maximized', focused: true });
      viewerTabId = window?.tabs?.[0]?.id;
      if (!window || window.id === undefined || viewerTabId === undefined) throw new Error('没有创建图表窗口');
      record = { ...record, viewerWindowId: window.id, viewerTabId, mode: 'popup' };
    } catch {
      const tab = await browser.tabs.create({ url, windowId: draft.sourceWindowId, active: false });
      viewerTabId = tab.id;
      if (viewerTabId === undefined) throw new Error('没有创建图表标签');
      record = { ...record, viewerWindowId: tab.windowId, viewerTabId, mode: 'tab' };
    }
    // 原文章可能在窗口创建期间关闭；清理监听器已删掉记录时，不重新复活它。
    const alive = await browser.storage.session.get(key);
    const currentSource = await browser.tabs.get(draft.sourceTabId);
    if (!alive[key] || currentSource.windowId !== draft.sourceWindowId) throw new Error('来源文章已关闭');
    await browser.storage.session.set({ [key]: record });
    if (record.mode === 'tab') await waitForTabReady(viewerTabId);
    await browser.tabs.update(viewerTabId, { active: true });
    await browser.windows.update(record.viewerWindowId!, { focused: true });
    return record;
  } catch (error) {
    await browser.storage.session.remove(key);
    if (viewerTabId !== undefined && await isCurrentDiagramViewer(record)) await browser.tabs.remove(viewerTabId).catch(() => {});
    throw error;
  }
}
