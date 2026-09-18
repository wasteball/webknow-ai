import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext } from '@playwright/test';

/**
 * 端到端冒烟：打包扩展能启动、侧栏能连上后台、状态由真实存储推导。
 * 这里不调用 DeepSeek：真实连接需要用户自己的 Key，属于 A0 的人工验证项。
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');

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

/**
 * 点工具栏图标这条路径无法自动化（浏览器外壳点不到），但它的两个前提可以验证：
 * 侧栏配置正确，以及声明了 activeTab。
 *
 * 真实故障：漏声明 activeTab → 点图标后扩展拿不到标签页地址 → 不知道该向哪个网站
 * 申请读取权限 → 用户既看不到授权弹窗，又收到“读不到这一页”。
 */
test('侧栏已配置且启用（工具栏点击的前提）', async () => {
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('缺少 service worker');
  const options = await worker.evaluate(() => chrome.sidePanel.getOptions({}));
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.side_panel?.default_path).toBeTruthy();
  expect(options.path ?? manifest.side_panel?.default_path).toBeTruthy();
  expect(options.enabled).not.toBe(false);
});

test('声明了 activeTab（否则扩展拿不到当前页地址，无法申请站点权限）', async () => {
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('缺少 service worker');
  const permissions = await worker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(permissions).toContain('activeTab');
  // 仍然不申请 tabs：那会带来“读取浏览历史”的安装警告。
  expect(permissions).not.toContain('tabs');
});

test('未配置 Key 时侧栏进入配置状态', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // 断言输入框而不是小节标题：标题属于会变的文案，输入框是功能本身。
  await expect(page.getByLabel('把以 sk- 开头的那串字符粘贴到这里')).toBeVisible();
  await expect(page.getByText('还没有填 DeepSeek 钥匙')).toBeVisible();
  // 第一次打开的样子是普通读者看到的第一屏，留一张截图供人工复核文案。
  await page.screenshot({ path: 'test-results/panel-first-run.png', fullPage: true });
  await page.close();
});

/**
 * CORS 是 A0 里唯一必须在浏览器内才能证实的假设：DeepSeek 的响应不带
 * access-control-allow-origin，扩展依赖 host 权限豁免。用无效 Key 打真实端点，
 * 能读到 401 就说明请求确实发出并被读取（被 CORS 拦下会抛 TypeError）。
 */
test('扩展页与后台都能直连 DeepSeek（host 权限豁免 CORS）', async () => {
  const body = JSON.stringify({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  });
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer sk-invalid-cors-probe' };

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const fromPage = await page.evaluate(
    async ([url, payload, headerSet]) => {
      try {
        const response = await fetch(url as string, {
          method: 'POST',
          headers: headerSet as Record<string, string>,
          body: payload as string,
        });
        return { ok: true, status: response.status };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    ['https://api.deepseek.com/chat/completions', body, headers] as const,
  );
  await page.close();

  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('缺少 service worker');
  const fromWorker = await worker.evaluate(async () => {
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-invalid-cors-probe' },
        body: JSON.stringify({
          model: 'deepseek-flash',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      return { ok: true, status: response.status };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });

  expect(fromPage, `侧栏页请求失败：${JSON.stringify(fromPage)}`).toMatchObject({ ok: true, status: 401 });
  expect(fromWorker, `后台请求失败：${JSON.stringify(fromWorker)}`).toMatchObject({ ok: true, status: 401 });
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
  await expect(page.getByText('等你在浏览器里允许读取这个网站')).toBeVisible();

  // 真实反馈回归：未确认外发时，“开始伴读”曾经是禁用且不说明原因，
  // 用户点了没反应。现在的合同是：按钮始终可用，并用文案说明这一下会同时记下确认。
  const startButton = page.getByRole('button', { name: /开始伴读/ });
  await expect(startButton).toBeEnabled();
  await expect(startButton).toHaveText(/我确认/);
  await page.close();
});
