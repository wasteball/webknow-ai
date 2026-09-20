import { appError, fromThrown } from '../core/errors';
import type { ContentReply, ContentRequest } from '../core/protocol';
import { currentIdentity, extractDocument, jumpToAnchor } from './extract';
import { startQuoteAsk } from './select';

/**
 * 内容脚本：只在被显式调用时读取当前页，自身不扫描、不上报、不预生成（FR-005）。
 * 它没有 Key、没有网络权限，也不接受来自网页的指令。
 */

const WATCH_FLAG = '__wkaWatching';

function safe(run: () => unknown): ContentReply {
  try {
    return { ok: true, data: run() };
  } catch (error) {
    return { ok: false, error: fromThrown(error) };
  }
}

/** SPA 路由变化可检测时上报，让后台把旧结果标为陈旧（FR-005）。 */
function startWatching(): void {
  const scope = globalThis as typeof globalThis & { [WATCH_FLAG]?: boolean };
  if (scope[WATCH_FLAG]) return;
  scope[WATCH_FLAG] = true;

  const notify = () => {
    void browser.runtime.sendMessage({ type: 'pageChanged', url: location.href }).catch(() => {
      // 后台暂时不可达时忽略：真正写回前仍会核验页面身份。
    });
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function patched(this: History, ...args: Parameters<History['pushState']>) {
      const before = location.href;
      const result = original.apply(this, args);
      if (location.href !== before) notify();
      return result;
    } as History[typeof method];
  }
  addEventListener('popstate', notify);
  addEventListener('hashchange', notify);
}

export function handleContentRequest(request: ContentRequest): ContentReply {
  switch (request.type) {
    case 'extract':
      startQuoteAsk();
      return safe(extractDocument);
    case 'fingerprint':
      return safe(currentIdentity);
    case 'jump':
      return safe(() => jumpToAnchor(request.anchor));
    case 'watch':
      startWatching();
      startQuoteAsk();
      return { ok: true, data: null };
    default:
      return { ok: false, error: appError('INTERNAL', '内容脚本收到未知请求。') };
  }
}
