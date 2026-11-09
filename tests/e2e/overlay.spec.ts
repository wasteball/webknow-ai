import { outboundFixture } from './helpers/consent';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';

/**
 * 页内浮层：在真实网页里注入，面板是扩展页 iframe，右侧停靠、可拖宽、可收起。
 * 工具栏点击在无头浏览器里点不到，这里直接走后台同一个 sendOverlay（注入内容脚本 + 打开）。
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');
const OUT = resolve(process.cwd(), 'test-results/overlay');
const ARTICLE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>配送试点</title>
<style>body{font:16px/1.8 system-ui;margin:0 auto;max-width:720px;padding:24px}</style></head>
<body><article><h1>城市配送试点研究</h1>
<p>本研究观察三个配送团队四周，新方案的平均处理时间为八十分钟，原方案为一百分钟。</p>
<p>该结果仅来自三个已完成工具培训的团队，不能直接外推到其他城市。</p></article></body></html>`;

let context: BrowserContext;
let origin: string;
let server: ReturnType<typeof createServer>;

test.beforeAll(async () => {
  server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(ARTICLE); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-overlay-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: 1280, height: 860 },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(async (outbound) => chrome.storage.local.set({ config: { apiKey: 'sk-test-not-real', outbound } }), outboundFixture());
});
test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((done) => server.close(() => done()));
});

async function openArticle(): Promise<{ page: Page; tabId: number }> {
  const page = await context.newPage();
  await page.goto(`${origin}/article.html`);
  await page.bringToFront();
  const worker = context.serviceWorkers()[0]!;
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]!.id!, `${origin}/article.html`);
  return { page, tabId };
}

async function overlay(tabId: number, action: 'open' | 'toggle' | 'close') {
  await context.serviceWorkers()[0]!.evaluate(async ([id, act]) => {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['/content-scripts/content.js'] });
    return chrome.tabs.sendMessage(id, { type: 'overlay', action: act, tabId: id });
  }, [tabId, action] as const);
}

async function panelFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((frame) => frame.url().includes('sidepanel.html'))).toBe(true);
  return page.frames().find((frame) => frame.url().includes('sidepanel.html'))!;
}

// 宿主是封闭 shadow root，网页拿不到里面；面板宽度从 iframe 自己的窗口量。
const panelWidth = (frame: Frame) => frame.evaluate(() => window.innerWidth);
// 面板盖没盖在网页上：看右侧那一点落在浮层宿主上还是网页正文上（隐藏的 iframe 会保留旧尺寸，不能只量宽度）。
const covering = (page: Page, x = 1100, y = 400) => page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.id === 'wka-overlay', [x, y] as const);

test('页内浮层：右侧停靠、绑定自己的标签页、正文不被挤压、可拖宽、可收起再展开', async () => {
  const { page, tabId } = await openArticle();
  const articleWidthBefore = await page.locator('article').evaluate((node) => node.getBoundingClientRect().width);
  await overlay(tabId, 'open');
  const frame = await panelFrame(page);
  expect(new URL(frame.url()).searchParams.get('host')).toBe('overlay');
  expect(new URL(frame.url()).searchParams.get('tab')).toBe(String(tabId));

  // 面板就是原来的面板：开始阅读入口照常出现。
  await expect(frame.getByRole('button', { name: '开始阅读' })).toBeVisible();
  await expect(frame.getByRole('button', { name: '收起面板' })).toBeVisible();

  // 盖在网页上，不挤压正文；网页脚本看不到面板的 shadow root，也读不到面板里的字。
  expect(await page.locator('article').evaluate((node) => node.getBoundingClientRect().width)).toBe(articleWidthBefore);
  expect(await page.evaluate(() => document.getElementById('wka-overlay')?.shadowRoot ?? null)).toBeNull();
  expect(await page.evaluate(() => document.body.innerText.includes('开始阅读'))).toBe(false);

  // 默认 400 宽（含 6px 拖动条的一半重叠）、全高、贴右边。
  await expect.poll(() => panelWidth(frame)).toBeGreaterThanOrEqual(395);
  expect(await panelWidth(frame)).toBeLessThanOrEqual(400);
  expect(await frame.evaluate(() => window.innerHeight)).toBe(860);
  await page.screenshot({ path: `${OUT}/overlay-open.png` });

  // 拖左边缘调宽：往左拖 200px，面板变宽，并记住宽度。
  const edge = 1280 - 400;
  await page.mouse.move(edge + 1, 400);
  await page.mouse.down();
  await page.mouse.move(edge - 100, 400, { steps: 5 });
  await page.mouse.move(edge - 200, 400, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => panelWidth(frame)).toBeGreaterThan(560);
  const saved = await context.serviceWorkers()[0]!.evaluate(async () => (await chrome.storage.local.get('overlayWidth')).overlayWidth);
  expect(saved).toBeGreaterThan(560);
  // 最宽不超过窗口的 70%，最窄 320。
  await page.mouse.move(edge - 199, 400);
  await page.mouse.down();
  await page.mouse.move(10, 400, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => panelWidth(frame)).toBeLessThanOrEqual(Math.round(1280 * 0.7));
  await page.screenshot({ path: `${OUT}/overlay-wide.png` });

  // 切到别的标签页再回来，面板仍然属于这一页（不跟着激活的标签页走）。
  const other = await context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await page.bringToFront();
  await expect(frame.getByRole('button', { name: '开始阅读' })).toBeVisible();
  await other.close();

  // 收起：面板消失，右边留小把手；再次打开（工具栏同一个 toggle）就回来。
  expect(await covering(page)).toBe(true);
  await frame.getByRole('button', { name: '收起面板' }).click();
  await expect.poll(() => covering(page)).toBe(false);
  // 收起后只剩右边缘的小把手，点它能展开。
  // 把手在右边缘、40% 高度处（860 × 0.4 = 344 起，高 44）。
  expect(await covering(page, 1270, 366)).toBe(true);
  await page.screenshot({ path: `${OUT}/overlay-collapsed.png` });
  await page.mouse.click(1270, 366);
  await expect.poll(() => covering(page)).toBe(true);
  await expect(frame.getByRole('button', { name: '开始阅读' })).toBeVisible();

  // 再点一次工具栏 = 收起；页面里始终只有一个浮层。
  await overlay(tabId, 'toggle');
  await expect.poll(() => covering(page)).toBe(false);
  await overlay(tabId, 'open');
  await expect.poll(() => covering(page)).toBe(true);
  expect(page.frames().filter((item) => item.url().includes('sidepanel.html'))).toHaveLength(1);
  await page.close();
});

test('页内浮层里完整读一页：开始阅读 → 摘要 → 提问 → 回答；原文能回跳', async () => {
  const sse = (output: unknown) => `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
  let calls = 0;
  await context.route('https://api.deepseek.com/chat/completions', async (route) => {
    calls += 1;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(calls === 1
      ? { summary: '试点把处理时间从一百分钟降到八十分钟，但只有三个团队。', bubbles: [] }
      : { answer: '不能。样本只有三个已培训的团队。', source: 'original', citations: ['b_2'], unanswered: [], followUps: [] }) });
  });
  const { page, tabId } = await openArticle();
  // 和工具栏点击一样：这次点击给了当前页临时读取权，先记下这一页。
  await context.serviceWorkers()[0]!.evaluate(async ([id, url, o]) => chrome.storage.session.set({ [`pending:${id}`]: { url, origin: o, at: Date.now() } }),
    [tabId, `${origin}/article.html`, origin] as const);
  await overlay(tabId, 'open');
  const frame = await panelFrame(page);
  await frame.getByRole('button', { name: '开始阅读', exact: true }).click();
  await expect(frame.locator('.said-guide')).toContainText('八十分钟');
  await frame.getByLabel('向这篇文章提问').fill('能推广到其他城市吗？');
  await frame.getByRole('button', { name: '发送', exact: true }).click();
  await expect(frame.locator('#mode-panel-qa .msg.ai .said:not(.said-guide)').last()).toContainText('样本只有三个');
  await page.screenshot({ path: `${OUT}/overlay-answer.png` });
  // 点「原文 1」回到网页上的那一段：浮层里的操作作用在它所在的这个网页上。
  await frame.getByRole('button', { name: /回到文中 1/ }).click();
  await expect.poll(() => page.evaluate(() => document.querySelector('.wka-evidence-highlight')?.textContent ?? '')).toContain('三个已完成工具培训');
  await context.unroute('https://api.deepseek.com/chat/completions');
  await page.close();
});
