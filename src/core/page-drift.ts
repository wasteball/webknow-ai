import type { BlocksPayload, EvidenceBlock, PictureRef } from './blocks';
import { appError, type AppError } from './errors';
import type { PageSession } from './session';
import { applyImageReadings } from './vision';

/** 同一篇文章的地址。查询参数和锚点会变，路径才是另一页。 */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function sameDocument(left: string, right: string): boolean {
  return pageKey(left) === pageKey(right);
}

function assetKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function samePictures(left?: PictureRef[], right?: PictureRef[]): boolean {
  const key = (pictures?: PictureRef[]) => (pictures ?? []).map((picture) => assetKey(picture.url)).join('\n');
  return key(left) === key(right);
}

/**
 * 发出去之后，这一页相对开始读的时候变成了什么样。
 * 同一地址上正文改过，和换了一页不是一回事。
 */
export type PageDrift = 'same' | 'edited' | 'replaced' | 'unreadable';

export type WriteBackPlan =
  | { action: 'commit' }
  | { action: 'replaced'; url: string }
  | { action: 'unreadable' };

export function classifyPageDrift(
  session: { url: string; fingerprint: string },
  live: { url: string; fingerprint: string } | null,
): PageDrift {
  if (!live?.url || typeof live.fingerprint !== 'string') return 'unreadable';
  if (!sameDocument(live.url, session.url)) return 'replaced';
  if (live.fingerprint !== session.fingerprint) return 'edited';
  return 'same';
}

/** 同一页改过稿仍写上这次结果。地址变了才丢掉。对不上页面时不能当成成功。 */
export function planWriteBack(drift: PageDrift, live: { url: string } | null): WriteBackPlan {
  if (drift === 'replaced') {
    return live?.url ? { action: 'replaced', url: live.url } : { action: 'unreadable' };
  }
  if (drift === 'unreadable') return { action: 'unreadable' };
  return { action: 'commit' };
}

export function writeBackError(plan: WriteBackPlan): AppError | null {
  if (plan.action === 'commit') return null;
  if (plan.action === 'replaced') {
    return appError('STALE_PAGE', '这一页已经换了，刚才那次没有写上。点一下就能读新的这一页。', true);
  }
  return appError('STALE_PAGE', '这一页暂时对不上，刚才那次没有写上。再发一次就行。', true);
}

/**
 * 同一地址上换上刚读到的正文。已经说过的话和正在进行的请求都留着。
 * 地址变了则不是这一页的改稿。
 */
/**
 * 图已经读过、地址只是换了防盗链参数时，把转述留在新正文里。
 * 否则每次追问都会把同一批图再读一遍，对话像是卡住。
 */
function keepReadImages(session: PageSession, page: BlocksPayload): {
  blocks: EvidenceBlock[];
  completeness: BlocksPayload['completeness'];
  imagesAttached: boolean;
} {
  const unread = {
    blocks: page.blocks,
    completeness: page.completeness,
    imagesAttached: !page.pictures?.length,
  };
  if (!session.imagesAttached || !samePictures(session.pictures, page.pictures)) return unread;
  const readings = session.blocks
    .filter((block) => block.role === 'image')
    .map((block) => ({ id: block.id, text: block.content }));
  if (!readings.length) return { ...unread, imagesAttached: true };
  const applied = applyImageReadings(page.blocks, page.pictures ?? [], readings, page.completeness);
  return { blocks: applied.blocks, completeness: applied.completeness, imagesAttached: true };
}

export function sessionWithNewExtract(session: PageSession, page: BlocksPayload): PageSession | 'replaced' {
  if (!sameDocument(page.url, session.url)) return 'replaced';
  const kept = keepReadImages(session, page);
  return {
    ...session,
    url: page.url,
    title: page.title,
    fingerprint: page.fingerprint,
    blocks: kept.blocks,
    completeness: kept.completeness,
    pictures: page.pictures,
    imagesAttached: kept.imagesAttached,
    updatedAt: Date.now(),
  };
}
