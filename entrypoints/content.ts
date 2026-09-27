import { fromThrown } from '../src/core/errors';
import type { ContentRequest } from '../src/core/protocol';
import { capturePageImage } from '../src/content/pictures';
import { handleContentRequest } from '../src/content';

/**
 * runtime 注册：不在 manifest 里声明任何站点匹配，因此安装时不申请任何站点权限。
 * 只有用户在当前站点点击“授权并开始伴读”后，后台才会注入这个脚本（FR-003）。
 */
export default defineContentScript({
  registration: 'runtime',
  main() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const request = message as ContentRequest | undefined;
      if (!request || typeof request.type !== 'string') return false;
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
