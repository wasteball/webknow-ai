import { browser } from 'wxt/browser';

import type { BlocksPayload, DomAnchor, JumpOutcome } from '../core/blocks';
import { appError, fromThrown, isAppError, type AppError } from '../core/errors';
import { PAGE_READ_ORIGINS } from '../core/hosts';
import type { ContentReply, ContentRequest } from '../core/protocol';
import type { PageSession } from '../core/session';

/**
 * 与内容脚本的桥。页面内容只在这里进出扩展，且只在用户明确启动之后（FR-005）。
 */

/** 构建产物路径由 WXT 的 runtime 注册决定：entrypoints/content.ts → content-scripts/content.js */
const CONTENT_FILE = '/content-scripts/content.js';

export async function ensureInjected(tabId: number): Promise<void> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] });
  } catch (error) {
    throw isAppError(error)
      ? error
      : appError(
          'PAGE_UNSUPPORTED',
          '这一页读不了：可能是浏览器内部页面、扩展商店页面或文件页。请换一篇公开的文章页面。',
          false,
        );
  }
}

async function send(tabId: number, request: ContentRequest): Promise<ContentReply> {
  try {
    const reply = (await browser.tabs.sendMessage(tabId, request)) as ContentReply | undefined;
    if (!reply) {
      return { ok: false, error: appError('STALE_PAGE', '这一页还没准备好被读取。') };
    }
    return reply;
  } catch (error) {
    return {
      ok: false,
      error: appError(
        'STALE_PAGE',
        '这一页已经变了或者关掉了。重新点一次开始伴读。',
        true,
      ),
    };
  }
}

function unwrap<T>(reply: ContentReply): T {
  if (!reply.ok) throw reply.error;
  return reply.data as T;
}

/**
 * 提取正文；这一步之后才第一次产生可以外发的正文（FR-006）。
 *
 * 先自查站点权限，再注入：权限缺失和“这类页面读不了”是两种完全不同的处境，
 * 分别给不同的下一步，而不是统一报“读不到”。（真实故障：漏了 activeTab，
 * 扩展拿不到网址，于是既没申请权限也没告诉用户该点哪里。）
 */
export async function canReadPage(origin: string | null): Promise<boolean> {
  if (!origin) return false;
  try {
    if (await browser.permissions.contains({ origins: PAGE_READ_ORIGINS })) return true;
    return await browser.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

export async function extractPage(tabId: number, expectedOrigin: string | null): Promise<BlocksPayload> {
  if (expectedOrigin) {
    const granted = await canReadPage(expectedOrigin);
    if (!granted) {
      throw appError(
        'PERMISSION_MISSING',
        `还没有允许我们读网页。请点一下开始伴读，浏览器会问一次授权。`,
        false,
      );
    }
  }
  await ensureInjected(tabId);
  const payload = unwrap<BlocksPayload>(await send(tabId, { type: 'extract' }));
  if (!payload?.blocks?.length) {
    throw appError('EXTRACT_FAILED', '当前页面没有可用的正文块。', false);
  }
  return payload;
}

/** 让内容脚本开始上报 SPA 路由变化（FR-005）。 */
export async function watchPage(tabId: number): Promise<void> {
  await send(tabId, { type: 'watch' });
}

/** 写回前核验：页面身份与内容版本仍与开始时一致（FR-024）。 */
export async function pageStillMatches(tabId: number, session: PageSession): Promise<boolean> {
  const reply = await send(tabId, { type: 'fingerprint' });
  if (!reply.ok) return false;
  const identity = reply.data as { url: string; fingerprint: string };
  return identity.url === session.url && identity.fingerprint === session.fingerprint;
}

export async function jumpToOriginal(tabId: number, anchor: DomAnchor): Promise<JumpOutcome> {
  const reply = await send(tabId, { type: 'jump', anchor });
  if (!reply.ok) {
    return { outcome: 'failed', reason: reply.error.message };
  }
  return reply.data as JumpOutcome;
}

export function toAppError(error: unknown): AppError {
  return fromThrown(error);
}
