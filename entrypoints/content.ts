import type { ContentRequest } from '../src/core/protocol';
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
      sendResponse(handleContentRequest(request));
      // WXT 0.20+ 起 onMessage 不支持返回 Promise，必须用 sendResponse + return。
      return true;
    });
  },
});
