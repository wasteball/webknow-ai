import { fromThrown } from '../src/core/errors';
import type { ContentRequest } from '../src/core/protocol';
import { capturePageImage } from '../src/content/pictures';
import { handleContentRequest } from '../src/content';
import { handleOverlay } from '../src/content/overlay';

/**
 * runtime 注册：不在 manifest 里声明任何站点匹配，因此安装时不申请任何站点权限。
 * 只有用户在当前站点点击“授权并开始伴读”后，后台才会注入这个脚本（FR-003）。
 */
export default defineContentScript({
  registration: 'runtime',
  main() {
    // 每次打开浮层、读取正文都会再注入一次本脚本；监听只能注册一次，
    // 否则一条“切换浮层”会被执行两遍、互相抵消（实测：第二次点图标收不起来）。
    const scope = globalThis as typeof globalThis & { __wkaContentListener?: boolean };
    if (scope.__wkaContentListener) return;
    scope.__wkaContentListener = true;
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const request = message as ContentRequest | undefined;
      if (!request || typeof request.type !== 'string') return false;
      if (request.type === 'overlay') {
        sendResponse({ ok: handleOverlay(request.action, request.tabId) });
        return true;
      }
      if (request.type === 'captureImage') {
        void capturePageImage(request.url)
          .then((dataUrl) => sendResponse({ ok: true, data: dataUrl }))
          .catch((error: unknown) => sendResponse({ ok: false, error: fromThrown(error) }));
        return true;
      }
      sendResponse(handleContentRequest(request));
      // WXT 0.20+ 起 onMessage 不支持返回 Promise，必须用 sendResponse + return。
      return true;
    });
  },
});
