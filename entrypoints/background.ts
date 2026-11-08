import { browser } from 'wxt/browser';
import { fromThrown } from '../src/core/errors';
import { cleanupDiagrams, cleanupNavigatedDiagram } from '../src/background/diagram-cleanup';

import {
  onActionClicked,
  onContextMenuAsk,
  onPageChanged,
  onPermissionsRemoved,
  onQuoteSelected,
  panelOpenFor,
  onTabNavigating,
  onTabRemoved,
  onTabSettled,
  registerPanelPort,
  resetAfterUpdate,
} from '../src/background/router';

const CONTEXT_MENU_ID = 'wka-ask-selection';

export default defineBackground(() => {
  // 监听器必须在顶层同步注册，否则后台被回收重启后会漏掉消息（NFR-004）。
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'webknow') return;
    registerPanelPort(port);
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const data = message as { type?: string; url?: string; text?: string } | undefined;
    const tabId = sender.tab?.id;
    if (data?.type === 'pageChanged' && tabId !== undefined) {
      void onPageChanged(tabId, data.url ?? '');
    }
    if (data?.type === 'quoteSelected' && tabId !== undefined && typeof data.text === 'string') {
      void onQuoteSelected(tabId, data.text).then(
        // 稍等侧栏连上再回答“开没开”，页面上的小卡片才说得准。
        (error) => error ? sendResponse({ ok: false, error })
          : setTimeout(() => sendResponse({ ok: true, panelOpen: panelOpenFor(tabId) }), 600),
        (error) => sendResponse({ ok: false, error: fromThrown(error) }),
      );
      return true;
    }
    return false;
  });

  browser.action.onClicked.addListener((tab) => {
    void onActionClicked(tab);
  });

  // 右键菜单兜底：划词按钮没出现、或浏览器不让自动打开侧栏时，这条路总能用。
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === CONTEXT_MENU_ID && info.selectionText) void onContextMenuAsk(tab, info.selectionText);
  });

  browser.permissions.onRemoved.addListener(() => { void onPermissionsRemoved(); });

  browser.tabs.onRemoved.addListener((tabId) => {
    void onTabRemoved(tabId);
    void cleanupDiagrams({ tabId });
  });
  browser.windows.onRemoved.addListener((windowId) => { void cleanupDiagrams({ windowId }); });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') void onTabNavigating(tabId);
    if (changeInfo.status === 'complete') {
      void onTabSettled(tabId);
      void cleanupNavigatedDiagram(tabId);
    }
  });

  // 安装或更新后清掉旧的会话数据。
  // 真实故障：更新扩展后，面板仍在显示上一个版本存下来的报错文案，看起来像“修了没用”。
  // 会话数据本来就只服务于当前浏览会话，更新即作废是符合合同的。
  browser.runtime.onInstalled.addListener(() => {
    void resetAfterUpdate();
    // 菜单项随安装持久存在；重复创建会报错，先清再建。
    void browser.contextMenus.removeAll().then(() => browser.contextMenus.create({
      id: CONTEXT_MENU_ID, title: '问 WebKnow AI', contexts: ['selection'],
    }));
  });
});
