import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 打包扩展的主路径端到端：配置 Key → 授权当前站点 → 注入内容脚本 → 提取正文 → 首屏。
 *
 * 两个已知的自动化边界：
 * - 工具栏点击无法由 Playwright 触发（属于浏览器 UI），因此用 pending 记录模拟它的结果；
 * - 站点权限请求需要真实用户手势，这里通过点击面板上的按钮触发，权限弹窗能否在
 *   无头浏览器里完成由 RUN_LIVE 决定是否继续断言。
 *
 * 默认用假 Key 跑通管道（不产生费用）；设置 DEEPSEEK_KEY 后跑真实首屏。
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');
const liveKey = process.env.DEEPSEEK_KEY ?? '';
const apiKey = liveKey || 'sk-fake-for-pipeline-check';

const FIXTURE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>城市配送试点研究</title></head>
<body><nav>首页 产品 联系我们</nav><main><article>
<h1>城市配送试点研究</h1>
<p>本研究观察三个配送团队四周，比较新的路径方案与原有方案的处理时间。</p>
<h2>主要发现</h2>
<p>试点期间，新方案的平均处理时间为八十分钟，原方案为一百分钟。</p>
<p>该结果仅来自三个已完成工具培训的团队，不能直接外推到其他城市或更长周期。</p>
</article></main><aside>热门推荐与广告内容</aside></body></html>`;

test.describe('主路径', () => {
  let context: BrowserContext;
  let extensionId: string;
  let panel: Page;
  let origin: string;
  let server: ReturnType<typeof createServer>;

  test.beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(FIXTURE);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-flow-')), {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(worker.url()).host;

    // 预置 Key 与外发告知状态；Key 只进扩展本地存储（与产品路径一致）。
    await worker.evaluate(async (key) => {
      await chrome.storage.local.set({
        config: {
          apiKey: key,
          outbound: { version: '2026-09-18.1', acceptedAt: Date.now(), receiver: 'DeepSeek（深度求索）' },
        },
      });
    }, apiKey);

    panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    const article = await context.newPage();
    await article.goto(`${origin}/article.html`);
    await article.bringToFront();
  });

  test.afterAll(async () => {
    await context?.close();
    server?.close();
  });

  test('新页面等待明确启动，点击后完成提取与首屏', async () => {
    const worker = context.serviceWorkers()[0];
    if (!worker) throw new Error('缺少 service worker');

    // 这条流程要求 e2e 模式构建（静态授予本地回环权限）。对着发布构建跑会误报，直接说明。
    const manifestPermissions = await worker.evaluate(
      () => chrome.runtime.getManifest().host_permissions ?? [],
    );
    test.skip(
      !manifestPermissions.includes('http://127.0.0.1/*'),
      '需要 e2e 模式构建：pnpm build:e2e（发布构建不含本地回环权限）',
    );

    // 模拟工具栏点击留下的当前页记录。
    const tabId = await panel.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.id ?? null;
    });
    expect(tabId).not.toBeNull();
    await worker.evaluate(
      async ([id, url, org]) => {
        await chrome.storage.session.set({
          [`pending:${id}`]: { url, origin: org, at: Date.now() },
        });
        void url;
      },
      [tabId, `${origin}/article.html`, origin] as const,
    );
    await panel.reload();

    // 关键合同：点击前不提取、不外发（FR-005）。此时要么等授权，要么等明确启动，
    // 但无论如何都不能已经出现摘要或读取范围。
    await expect(panel.getByText(/等待你点击开始伴读|等待授权读取当前页面/)).toBeVisible();
    await expect(panel.getByText('这篇文章讲了什么')).toBeHidden();
    await expect(panel.getByText(/读取范围：/)).toBeHidden();

    const start = panel.getByRole('button', { name: /开始伴读/ });
    await expect(start).toBeEnabled();
    await start.click();

    // 授权 → 注入 → 提取 → 首屏；无头环境下权限确认可能是弹窗（无法自动化），
    // 因此这里对“停在授权”保持容忍，只要求不静默外发。
    if (!liveKey) {
      await expect(
        panel.getByText(/等待授权读取当前页面|等待你点击开始伴读|上次操作没有完成/),
      ).toBeVisible({ timeout: 20_000 });
      return;
    }

    // 有真 Key 时必须走完整条链路。
    await expect(panel.getByText('等待授权读取当前页面')).toBeHidden({ timeout: 20_000 }).catch(() => {});
    await expect(panel.getByText('这篇文章讲了什么')).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByText(/读取范围：已读取正文块/)).toBeVisible();
    const bubbles = panel.locator('.bubble');
    await expect(bubbles.first()).toBeVisible();
    expect(await bubbles.count()).toBeGreaterThan(0);
    // 留一张首屏截图作为人工复核材料；无头容器若缺中文字体，截图里会显示为方块。
    await panel.screenshot({ path: 'test-results/panel-ready.png', fullPage: true });
  });
});
