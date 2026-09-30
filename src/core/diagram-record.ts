/** SVG 只存浏览会话；URL 只带随机 ID，来源必须与实际查看器标签绑定。 */
export type DiagramRecord = {
  id: string;
  svg: string;
  title: string;
  sourceTabId: number;
  sourceWindowId: number;
  viewerTabId?: number;
  viewerWindowId?: number;
  mode?: 'popup' | 'tab';
  createdAt: number;
};
export type DiagramDraft = Pick<DiagramRecord, 'svg' | 'title' | 'sourceTabId' | 'sourceWindowId'>;
export const DIAGRAM_PREFIX = 'diagram:';
export const diagramKey = (id: string) => `${DIAGRAM_PREFIX}${id}`;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export function parseDiagramRecord(value: unknown): DiagramRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<DiagramRecord>;
  if (!validId(record.id) || typeof record.svg !== 'string' || !record.svg.trimStart().startsWith('<svg') ||
    typeof record.title !== 'string' || !positiveId(record.sourceTabId) || !positiveId(record.sourceWindowId) ||
    typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) ||
    (record.viewerTabId !== undefined && !positiveId(record.viewerTabId)) ||
    (record.viewerWindowId !== undefined && !positiveId(record.viewerWindowId))) return null;
  return record as DiagramRecord;
}

export function diagramIdFromUrl(url: string, ownViewerUrl: string): string | null {
  try {
    const current = new URL(url);
    const own = new URL(ownViewerUrl);
    const id = current.searchParams.get('diagram');
    return current.protocol === own.protocol && current.host === own.host && current.pathname === own.pathname && validId(id) ? id : null;
  } catch { return null; }
}

export function matchesDiagramViewer(record: DiagramRecord, viewer: { id?: number; windowId: number }, url: string, ownViewerUrl: string): boolean {
  return diagramIdFromUrl(url, ownViewerUrl) === record.id && record.viewerTabId === viewer.id &&
    record.viewerWindowId === viewer.windowId && record.sourceTabId !== viewer.id;
}
