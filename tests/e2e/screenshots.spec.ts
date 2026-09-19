import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 生成使用指南里的界面截图。UI 改动后重跑本文件即可更新文档配图：
 *
 *   pnpm build:e2e
 *   DEEPSEEK_KEY=sk-... npx playwright test tests/e2e/screenshots.spec.ts
 *
 * 图片写到本仓库的 docs/images/，供 README.md 与安装说明引用。
 * 浏览器外壳（chrome://extensions、工具栏图标）无法由 Playwright 截图，指南里那几步只能用文字。
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');
const OUTPUT_DIR = resolve(process.cwd(), 'docs/images');
const liveKey = process.env.DEEPSEEK_KEY ?? '';

const FIXTURE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>城市配送试点研究</title></head>
<body><nav>首页 产品 联系我们</nav><main><article>
<h1>城市配送试点研究</h1>
<p>本研究观察三个配送团队四周，比较新的路径方案与原有方案的处理时间。</p>
<h2>主要发现</h2>
<p>试点期间，新方案的平均处理时间为八十分钟，原方案为一百分钟。</p>
<p>该结果仅来自三个已完成工具培训的团队，不能直接外推到其他城市或更长周期。</p>
</article></main><aside>热门推荐与广告内容</aside></body></html>`;

let context: BrowserContext;
let extensionId: string;
let panel: Page;
let origin: string;
let server: ReturnType<typeof createServer>;

test.beforeAll(async () => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(FIXTURE);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-shot-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: 400, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
});

test('首次配置界面', async () => {
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByText('还没有填 DeepSeek 钥匙')).toBeVisible();
  await panel.screenshot({ path: join(OUTPUT_DIR, 'panel-01-setup.png'), fullPage: true });
  await panel.close();
});

test('首屏摘要与话题', async () => {
  test.skip(!liveKey, '需要 DEEPSEEK_KEY 才能生成首屏截图');
  // 真实模型的用例：这一条要跑导览 + 出题 + 一轮作答，全量跑时前面还有别的真实调用，
  // 默认的 60 秒不够用（单独跑只要几秒）。
  test.setTimeout(180_000);
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('缺少 service worker');

  await worker.evaluate(async (key) => {
    await chrome.storage.local.set({
      config: {
        apiKey: key,
        outbound: { version: '2026-09-19.1', acceptedAt: Date.now(), receiver: 'DeepSeek（深度求索）' },
      },
    });
  }, liveKey);

  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const article = await context.newPage();
  await article.goto(`${origin}/article.html`);
  await article.bringToFront();

  const tabId = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
  });
  await worker.evaluate(
    async ([id, url, org]) => {
      await chrome.storage.session.set({ [`pending:${id}`]: { url, origin: org, at: Date.now() } });
    },
    [tabId, `${origin}/article.html`, origin] as const,
  );
  await panel.reload();

  await panel.getByRole('button', { name: /开始伴读/ }).click();
  await expect(panel.getByText('这篇文章讲了什么')).toBeVisible({ timeout: 60_000 });
  await expect(panel.locator('.bubble').first()).toBeVisible();
  await panel.screenshot({ path: join(OUTPUT_DIR, 'panel-02-guide.png'), fullPage: true });

  // “AI 问我”：真答一轮再截图。只截第一题的话，画面大半是空白，
  // 看不出"一次一个问题"是怎么一步步推进的——那正是翠色时间线要表达的东西。
  await panel.getByRole('button', { name: '让 AI 问我' }).click();
  await expect(panel.locator('.entry-question').first()).toBeVisible({ timeout: 60_000 });

  await panel.getByLabel('用自己的话回答').fill(
    '新方案在这个试点里平均用了八十分钟，比原方案的一百分钟少；但作者提醒只有三个受过培训的团队，不能推广。',
  );
  await panel.getByRole('button', { name: '回答' }).click();
  await expect(panel.locator('.entry-feedback').first()).toBeVisible({ timeout: 60_000 });
  await expect(panel.locator('.entry-question').nth(1)).toBeVisible({ timeout: 60_000 });
  await panel.screenshot({ path: join(OUTPUT_DIR, 'panel-03-learning.png'), fullPage: true });
  await article.close();
  await panel.close();
});
