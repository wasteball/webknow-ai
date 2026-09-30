import { browser } from 'wxt/browser';

/** 整页扩展视图加载后再激活，让无 tabs 权限的侧栏能通过 getViews 识别来源。 */
export async function waitForTabReady(id: number): Promise<void> {
  if ((await browser.tabs.get(id)).status === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(updated);
      browser.tabs.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve();
    };
    const updated = (tabId: number, change: { status?: string }) => { if (tabId === id && change.status === 'complete') finish(); };
    const removed = (tabId: number) => { if (tabId === id) finish(new Error('图表标签已关闭')); };
    const timeout = setTimeout(() => finish(new Error('图表加载超时，请重试')), 10_000);
    browser.tabs.onUpdated.addListener(updated); browser.tabs.onRemoved.addListener(removed);
    void browser.tabs.get(id).then((tab) => { if (tab.status === 'complete') finish(); }, (error: Error) => finish(error));
  });
}
