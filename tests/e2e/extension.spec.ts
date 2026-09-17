import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext } from '@playwright/test';

/**
 * 端到端冒烟：打包扩展能启动、侧栏能连上后台、状态由真实存储推导。
 * 这里不调用 DeepSeek：真实连接需要用户自己的 Key，属于 A0 的人工验证项。
 */

/** 在 service worker 里求值时可用；这里只需要用到存储相关的两个方法。 */
declare const chrome: {
  storage: {
    local: { set(items: Record<string, unknown>): Promise<void> };
    session: { get(keys: null): Promise<Record<string, unknown>> };
  };
};

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3');

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

test('后台以 MV3 service worker 启动', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test('未配置 Key 时侧栏进入配置状态', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('heading', { name: '配置 DeepSeek Key' })).toBeVisible();
  await expect(page.getByText('尚未配置 DeepSeek Key')).toBeVisible();
  await page.close();
});

test('保存的 Key 留在扩展本地存储，且不进入页面会话', async () => {
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('缺少 service worker');
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ config: { apiKey: 'sk-test-not-a-real-key' } });
  });
  const sessionDump = await worker.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return JSON.stringify(all);
  });
  expect(sessionDump).not.toContain('sk-test-not-a-real-key');

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // 有 Key、无站点权限：应停在“等待授权”，而不是继续外发。
  await expect(page.getByText('等待授权读取当前页面')).toBeVisible();
  await page.close();
});
