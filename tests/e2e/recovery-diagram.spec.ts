import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext } from '@playwright/test';

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');
const ANSWER = '可以画成流程：\n\n```mermaid flowchart LR; A[开始] --> B[观察] --> C[判断] --> D[分析] --> E[设计] --> F[试行] --> G[评估] --> H[调整] --> I[验证] --> J[汇总] --> K[复盘] --> L[优化] --> M[结束]; ```\n\n图下还有说明。';
const WIDE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2400 200" width="2400" height="200"><rect width="2400" height="200" fill="black"/></svg>';
const SMALL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><rect width="200" height="100" fill="black"/></svg>';
const TALL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 2000" width="200" height="2000"><rect width="200" height="2000" fill="black"/></svg>';

async function expectDiagramFits(page: import('@playwright/test').Page, stageSelector: string) {
  await expect.poll(async () => page.evaluate((selector) => {
    const stage = document.querySelector(selector)!.getBoundingClientRect();
    const svg = document.querySelector(`${selector} .viewer-canvas svg, ${selector} .canvas svg`)!.getBoundingClientRect();
    return svg.left >= stage.left - 1 && svg.right <= stage.right + 1
      && svg.top >= stage.top - 1 && svg.bottom <= stage.bottom + 1;
  }, stageSelector)).toBe(true);
}
const article = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>城市配送试点研究</title></head>
<body><main><article><h1>城市配送试点研究</h1>
<p>本研究观察三个配送团队四周，比较新的路径方案与原有方案的处理时间。</p>
<p>试点期间，新方案的平均处理时间为八十分钟，原方案为一百分钟。</p>
</article></main></body></html>`;

let server: Server;
let context: BrowserContext;
let origin: string;
let extensionId: string;

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(article);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-recovery-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      config: {
        apiKeys: { deepseek: 'sk-test-not-real' },
        outbound: { version: '2026-09-19.2', acceptedAt: Date.now(), receiver: 'DeepSeek（深度求索）' },
      },
    });
  });
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

test('无效回答后能继续提问，含 Mermaid 的有效回答画成图', async () => {
  test.setTimeout(120_000);
  const requests: string[] = [];
  await context.route('https://api.deepseek.com/chat/completions', async (route) => {
    const body = route.request().postDataJSON() as { messages: { content: string }[] };
    const question = body.messages.at(-1)?.content ?? '';
    requests.push(question);
    const output = requests.length === 1
      ? { summary: '试点缩短了平均配送时间。', bubbles: [] }
      : requests.length === 2
        ? '{INVALID JSON'
        : { answer: ANSWER, source: 'supplement', citations: [], unanswered: [], followUps: [] };
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    });
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const page = await context.newPage();
  await page.goto(`${origin}/article.html`);
  await page.bringToFront();
  const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null);
  expect(tabId).not.toBeNull();
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(async ([id, url, org]) => {
    await chrome.storage.session.set({ [`pending:${id}`]: { url, origin: org, at: Date.now() } });
  }, [tabId, `${origin}/article.html`, origin] as const);
  await panel.reload();
  await panel.getByRole('button', { name: '开始阅读' }).click();
  await expect(panel.getByText('试点缩短了平均配送时间。')).toBeVisible({ timeout: 20_000 });

  // 走真实的「开始伴读 → 网页划词 → 点击问这句 → 侧栏引用」路径，不预置 READY 会话。
  const quoteParagraph = page.locator('article p').nth(1);
  const quoteBox = await quoteParagraph.boundingBox();
  expect(quoteBox).toBeTruthy();
  await page.mouse.move(quoteBox!.x + 2, quoteBox!.y + quoteBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(quoteBox!.x + quoteBox!.width - 2, quoteBox!.y + quoteBox!.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.locator('#wka-quote-ask button').click();
  await expect(panel.locator('.quote-chip')).toContainText('八十分钟');
  await panel.getByRole('button', { name: '不用这段' }).click();

  const input = panel.getByLabel('向这篇文章提问');
  await input.fill('第一次为什么更快？');
  await panel.getByRole('button', { name: '发送' }).click();
  await expect(panel.getByRole('alert').getByText('这次生成的内容没法用，没有采用。可以再试一次。')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole('button', { name: '发送' })).toBeEnabled();
  await expect(input).toHaveValue('第一次为什么更快？');

  await input.fill('第二次画个流程图。');
  await panel.getByRole('button', { name: '发送' }).click();
  await expect(panel.getByRole('status').getByText('这次生成的内容没法用，没有采用。可以再试一次。')).toBeHidden();
  await expect(panel.locator('.diagram-canvas svg')).toBeVisible({ timeout: 30_000 });
  const nodeFills = await panel.locator('.diagram-canvas svg').evaluate((diagram) =>
    Array.from(diagram.querySelectorAll('.node rect, .node polygon, .node path')).map((shape) => getComputedStyle(shape).fill));
  const hasColoredNode = nodeFills.some((fill) => {
    const channels = fill.match(/\d+/g)?.slice(0, 3).map(Number);
    return channels !== undefined && Math.max(...channels) - Math.min(...channels) >= 20;
  });
  expect(hasColoredNode, `默认 Mermaid 节点应有可辨认的颜色，实际：${JSON.stringify(nodeFills)}`).toBe(true);
  await expect(panel.getByText('图下还有说明。')).toBeVisible();
  await expect(panel.getByRole('alert')).toBeHidden();
  expect(await worker.evaluate(async (id) => {
    const stored = await chrome.storage.session.get(`sess:${id}`);
    const session = stored[`sess:${id}`] as { chat: { question: string; answer: string }[]; state: string; run: unknown };
    return { chat: session.chat, state: session.state, run: session.run };
  }, tabId)).toMatchObject({
    chat: [{ question: '第二次画个流程图。', answer: expect.stringContaining('flowchart LR') }],
    state: 'READY',
    run: null,
  });
  expect(requests).toHaveLength(3);
  expect(requests[1]).toContain('第一次为什么更快？');
  expect(requests[2]).toContain('第二次画个流程图。');

  await panel.setViewportSize({ width: 360, height: 720 });
  await panel.getByLabel('向这篇文章提问').fill('看图回来继续问');
  const area = panel.locator('#mode-panel-qa .chat-scroll');
  await area.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const position = await area.evaluate((node) => node.scrollTop);
  const opened = context.waitForEvent('page');
  await panel.locator('.diagram-canvas').click();
  const viewer = await opened;
  await expect(viewer).toHaveURL(new RegExp(`chrome-extension://${extensionId}/viewer\\.html\\?diagram=`));
  await expect(viewer.locator('.canvas svg')).toContainText('开始');
  await expect(panel.getByRole('dialog', { name: '放大看图' })).toHaveCount(0);
  const window = await viewer.evaluate(() => chrome.windows.getCurrent());
  expect(window.type).toBe('popup');
  // Playwright 为新页面设置模拟 viewport 后，无头 Chrome 会回报 normal。
  // 最大化请求由 diagram-window 单测和真实 windows.create 探针验证。
  if (!(await viewer.evaluate(() => navigator.userAgent.includes('HeadlessChrome')))) expect(window.state).toBe('maximized');
  await expectDiagramFits(viewer, '.stage');
  for (const name of ['缩小', '放大', '适应画布', '100%', '全屏', '返回文章并关闭图表']) {
    await expect(viewer.getByRole('button', { name, exact: true })).toBeVisible();
  }
  expect(await viewer.locator('.stage').evaluate((node) => node.clientWidth)).toBeGreaterThan(360);
  const count = context.pages().length;
  await panel.locator('.diagram-canvas').click();
  expect(context.pages()).toHaveLength(count);
  await viewer.reload();
  await expect(viewer.locator('.canvas svg')).toContainText('开始');
  await viewer.getByRole('button', { name: '100%', exact: true }).click();
  await expect(viewer.locator('.zoom-label')).toHaveText('100%');
  const closed = viewer.waitForEvent('close');
  await viewer.getByRole('button', { name: '返回文章并关闭图表' }).click();
  await closed;
  await expect(panel.getByLabel('向这篇文章提问')).toHaveValue('看图回来继续问');
  expect(await area.evaluate((node) => node.scrollTop)).toBe(position);
  expect(await worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((key) => key.startsWith('diagram:')))).toEqual([]);
  // 真实调用失败后回退同窗口标签，仍须关联文章并保留草稿。
  await panel.evaluate(() => {
    chrome.windows.create = (async () => { throw new Error('popup denied for fallback test'); }) as typeof chrome.windows.create;
  });
  const fallbackOpened = context.waitForEvent('page');
  await panel.locator('.diagram-canvas').click();
  const fallback = await fallbackOpened;
  await expect(fallback.locator('.canvas svg')).toContainText('开始');
  expect((await fallback.evaluate(() => chrome.windows.getCurrent())).type).toBe('normal');
  await expect(panel.getByLabel('向这篇文章提问')).toHaveValue('看图回来继续问');
  const fallbackClosed = fallback.waitForEvent('close');
  await fallback.getByRole('button', { name: '返回文章并关闭图表' }).click();
  await fallbackClosed;
  await expect(panel.getByLabel('向这篇文章提问')).toHaveValue('看图回来继续问');
  await panel.close(); await page.close();
});

/** 大图几何回归直接预置可信会话记录；真实模型→Mermaid 的路径由上一个用例验证。 */
async function openFixture(svg: string, width = 1000, height = 700) {
  const worker = context.serviceWorkers()[0]!;
  const source = await context.newPage(); await source.goto('about:blank'); await source.bringToFront();
  const sourceTab = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]!);
  const id = crypto.randomUUID();
  const viewer = await context.newPage(); await viewer.setViewportSize({ width, height });
  await viewer.goto(`chrome-extension://${extensionId}/viewer.html?diagram=${id}`);
  const tab = await viewer.evaluate(() => chrome.tabs.getCurrent());
  await worker.evaluate(async (record) => { await chrome.storage.session.set({ [`diagram:${record.id}`]: record }); },
    { id, svg, title: '图表示例', sourceTabId: sourceTab.id!, sourceWindowId: sourceTab.windowId, viewerTabId: tab!.id!, viewerWindowId: tab!.windowId, mode: 'tab', createdAt: Date.now() });
  await viewer.reload(); await expect(viewer.locator('.canvas svg')).toBeVisible();
  return { viewer, source, id };
}

for (const [name, svg] of [['宽图', WIDE_SVG], ['高图', TALL_SVG]] as const) {
  test(`${name}自动适配，手动视角 resize 后保留，导航与键盘可操作`, async () => {
    const { viewer, source } = await openFixture(svg);
    await expectDiagramFits(viewer, '.stage');
    await expect(viewer.locator('.minimap')).toBeHidden();
    await viewer.setViewportSize({ width: 720, height: 500 });
    await expectDiagramFits(viewer, '.stage');
    await viewer.getByRole('button', { name: '100%', exact: true }).click();
    await expect(viewer.locator('.zoom-label')).toHaveText('100%');
    await expect(viewer.locator('.minimap')).toBeVisible();
    const before = await viewer.locator('.canvas').getAttribute('style');
    await viewer.getByRole('button', { name: '全图导航，点击定位' }).click({ position: { x: 12, y: 35 } });
    await expect(viewer.locator('.canvas')).not.toHaveAttribute('style', before!);
    const center = await worldCenter(viewer);
    await viewer.setViewportSize({ width: 900, height: 650 });
    await expect(viewer.locator('.zoom-label')).toHaveText('100%');
    await expect.poll(async () => worldCenter(viewer)).toEqual(center);
    const stage = viewer.locator('.stage'); const bounds = await stage.boundingBox();
    const point = { x: bounds!.x + 100, y: bounds!.y + 100 };
    const nodeBefore = await worldAt(viewer, point);
    await viewer.mouse.move(point.x, point.y); await viewer.mouse.wheel(0, -150);
    await expect(viewer.locator('.zoom-label')).not.toHaveText('100%');
    expect(await worldAt(viewer, point)).toEqual(nodeBefore);
    const oldPosition = await viewer.locator('.canvas').evaluate((node) => node.getBoundingClientRect().x);
    await stage.focus(); await viewer.keyboard.press('ArrowRight');
    expect(await viewer.locator('.canvas').evaluate((node) => node.getBoundingClientRect().x)).toBe(oldPosition - 40);
    await viewer.keyboard.press('0'); await expectDiagramFits(viewer, '.stage');
    const automatic = await viewer.locator('.zoom-label').textContent();
    await viewer.mouse.move(bounds!.x + 100, bounds!.y + 100); await viewer.mouse.down();
    await viewer.mouse.move(bounds!.x + 145, bounds!.y + 130); await viewer.mouse.up();
    await expect(viewer.locator('.zoom-label')).toHaveText(automatic!);
    await viewer.getByRole('button', { name: '适应画布' }).click(); await expectDiagramFits(viewer, '.stage');
    await viewer.close(); await source.close();
  });
}

async function worldAt(viewer: import('@playwright/test').Page, point: { x: number; y: number }) {
  return viewer.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.canvas')!;
    const box = canvas.getBoundingClientRect();
    const transform = new DOMMatrix(getComputedStyle(canvas).transform);
    return { x: Math.round((x - box.left) / transform.a * 100) / 100, y: Math.round((y - box.top) / transform.a * 100) / 100 };
  }, point);
}
async function worldCenter(viewer: import('@playwright/test').Page) {
  const stage = await viewer.locator('.stage').boundingBox();
  return worldAt(viewer, { x: stage!.x + stage!.width / 2, y: stage!.y + stage!.height / 2 });
}

test('小图居中，全屏切换保留手动视角，Esc 先退出全屏', async () => {
  const { viewer, source } = await openFixture(SMALL_SVG);
  await expect(viewer.locator('.zoom-label')).toHaveText('100%');
  await expect.poll(() => viewer.evaluate(() => {
    const stage = document.querySelector('.stage')!.getBoundingClientRect();
    const svg = document.querySelector('.canvas svg')!.getBoundingClientRect();
    return Math.round((svg.left - stage.left) - (stage.right - svg.right));
  })).toBe(0);
  await viewer.getByRole('button', { name: '放大', exact: true }).click();
  const label = await viewer.locator('.zoom-label').textContent();
  const center = await worldCenter(viewer);
  if (await viewer.evaluate(() => document.fullscreenEnabled)) {
    await viewer.getByRole('button', { name: '全屏', exact: true }).click();
    await expect.poll(() => viewer.evaluate(() => document.fullscreenElement?.id)).toBe('root');
    await expect(viewer.locator('.zoom-label')).toHaveText(label!);
    await expect.poll(() => worldCenter(viewer)).toEqual(center);
    await viewer.keyboard.press('Escape');
    await expect.poll(() => viewer.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(viewer.locator('.canvas svg')).toBeVisible();
  }
  await viewer.evaluate(() => { document.getElementById('root')!.requestFullscreen = () => Promise.reject(new Error('denied')); });
  await viewer.getByRole('button', { name: '全屏', exact: true }).click();
  await expect(viewer.getByRole('status')).toContainText('无法全屏');
  const closed = viewer.waitForEvent('close'); await viewer.keyboard.press('Escape'); await closed;
  await source.close();
});

test('记录失效与来源关闭有明确恢复行为，已经载入的图继续可看', async () => {
  const { viewer, source, id } = await openFixture(SMALL_SVG);
  await source.close();
  await expect(viewer.getByRole('status')).toContainText('来源文章已关闭');
  await expect(viewer.locator('.canvas svg')).toBeVisible();
  expect(await context.serviceWorkers()[0]!.evaluate(async (recordId) => (await chrome.storage.session.get(`diagram:${recordId}`))[`diagram:${recordId}`], id)).toBeUndefined();
  await viewer.reload();
  await expect(viewer.getByRole('status')).toContainText('已失效');
  await expect(viewer.getByRole('button', { name: '关闭图表' })).toBeVisible();
  await viewer.close();
});
