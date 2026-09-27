import { browser } from 'wxt/browser';

import type { BlocksPayload, DomAnchor, JumpOutcome } from '../core/blocks';
import { appError, fromThrown, isAppError, type AppError } from '../core/errors';
import { LIMITS } from '../core/limits';
import type { ContentReply, ContentRequest } from '../core/protocol';
import { unlockPageSelection } from '../content/select-unlock';

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
          'PERMISSION_MISSING',
          '读不了这一页。请点一下工具栏上的知伴图标——我们只在你打开产品时读当前这一页，不会一直盯着网页。',
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
        '这一页已经变了或者关掉了。再点一下工具栏上的知伴图标。',
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
 * 只在用户点了入口，或在同一页发出问题、而正文已经改过时调用。换页本身不读。
 */
/** 页面主世界放开选区。插不进去时内容脚本仍会显示「问这句」。 */
async function allowPageSelection(tabId: number): Promise<void> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: unlockPageSelection,
    });
  } catch {
    // 这一页不允许进主世界。划词仍走内容脚本。
  }
}

export async function extractPage(tabId: number): Promise<BlocksPayload> {
  await ensureInjected(tabId);
  await allowPageSelection(tabId);
  const payload = unwrap<BlocksPayload>(await send(tabId, { type: 'extract' }));
  if (!payload?.blocks?.length) {
    throw appError('EXTRACT_FAILED', '当前页面没有可用的正文块。', false);
  }
  return payload;
}

/** 让内容脚本开始上报 SPA 路由变化（FR-005）。 */
export async function watchPage(tabId: number): Promise<void> {
  await allowPageSelection(tabId);
  await send(tabId, { type: 'watch' });
}

/** 问内容脚本要当前地址和正文指纹。脚本不应或页面已关时返回 null。 */
export async function readPageIdentity(tabId: number): Promise<{ url: string; fingerprint: string } | null> {
  const reply = await send(tabId, { type: 'fingerprint' });
  if (!reply.ok) return null;
  const identity = reply.data as { url?: string; fingerprint?: string };
  if (!identity?.url || typeof identity.fingerprint !== 'string') return null;
  return { url: identity.url, fingerprint: identity.fingerprint };
}

/**
 * 在页面上下文里把图压成 jpeg。内容脚本先试；不行再进页面主世界，
 * 这样微信图床的防盗链 Referer 还在，又不给扩展加新的站点权限。
 */
export async function captureImage(tabId: number, url: string): Promise<string | null> {
  const reply = await send(tabId, { type: 'captureImage', url });
  if (reply.ok && typeof reply.data === 'string' && reply.data.startsWith('data:image/')) return reply.data;
  try {
    const [injected] = await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [url, LIMITS.maxImageEdge],
      func: async (imageUrl: string, edge: number) => {
        try {
          const response = await fetch(imageUrl);
          if (!response.ok) return null;
          const blob = await response.blob();
          if (blob.size > 8_000_000) return null;
          const bitmap = await createImageBitmap(blob);
          const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          const context = canvas.getContext('2d');
          if (!context) return null;
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
          const data = canvas.toDataURL('image/jpeg', 0.82);
          return data.length > 1_800_000 ? null : data;
        } catch {
          return null;
        }
      },
    });
    const data = injected?.result;
    return typeof data === 'string' && data.startsWith('data:image/') ? data : null;
  } catch {
    return null;
  }
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
