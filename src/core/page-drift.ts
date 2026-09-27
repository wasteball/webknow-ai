import type { BlocksPayload } from './blocks';
import { appError, type AppError } from './errors';
import type { PageSession } from './session';

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
  if (live.url !== session.url) return 'replaced';
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
export function sessionWithNewExtract(session: PageSession, page: BlocksPayload): PageSession | 'replaced' {
  if (page.url !== session.url) return 'replaced';
  return {
    ...session,
    title: page.title,
    fingerprint: page.fingerprint,
    blocks: page.blocks,
    completeness: page.completeness,
    updatedAt: Date.now(),
  };
}
