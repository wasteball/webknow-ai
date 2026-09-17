import { browser } from 'wxt/browser';

import {
  onActionClicked,
  onPageChanged,
  onTabNavigating,
  onTabRemoved,
  registerPanelPort,
} from '../src/background/router';

export default defineBackground(() => {
  // 监听器必须在顶层同步注册，否则后台被回收重启后会漏掉消息（NFR-004）。
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'webknow') return;
    registerPanelPort(port);
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    const data = message as { type?: string; url?: string } | undefined;
    const tabId = sender.tab?.id;
    if (data?.type === 'pageChanged' && tabId !== undefined) {
      void onPageChanged(tabId, data.url ?? '');
    }
    return false;
  });

  browser.action.onClicked.addListener((tab) => {
    void onActionClicked(tab);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void onTabRemoved(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') void onTabNavigating(tabId);
  });
});
