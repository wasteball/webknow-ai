import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext } from '@playwright/test';

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');
const ANSWER = '可以画成流程：\n\n```mermaid flowchart TD; A[开始] --> B[结束]; ```\n\n图下还有说明。';
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
  await panel.getByRole('button', { name: '总结摘要' }).click();
  await expect(panel.getByText('试点缩短了平均配送时间。')).toBeVisible({ timeout: 20_000 });

  const input = panel.getByLabel('向这篇文章提问');
  await input.fill('第一次为什么更快？');
  await panel.getByRole('button', { name: '发送' }).click();
  await expect(panel.getByRole('alert').getByText('这次生成的内容没法用，没有采用。可以再试一次。')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole('button', { name: '发送' })).toBeEnabled();
  await expect(input).toHaveValue('第一次为什么更快？');

  await input.fill('第二次画个流程图。');
  await panel.getByRole('button', { name: '发送' }).click();
  await expect(panel.getByRole('status').getByText('这次生成的内容没法用，没有采用。可以再试一次。')).toBeHidden();
  await expect(panel.locator('.diagram svg')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText('图下还有说明。')).toBeVisible();
  await expect(panel.getByRole('alert')).toBeHidden();
  expect(await worker.evaluate(async (id) => {
    const stored = await chrome.storage.session.get(`sess:${id}`);
    const session = stored[`sess:${id}`] as { chat: { question: string; answer: string }[]; state: string; run: unknown };
    return { chat: session.chat, state: session.state, run: session.run };
  }, tabId)).toMatchObject({
    chat: [{ question: '第二次画个流程图。', answer: expect.stringContaining('flowchart TD') }],
    state: 'READY',
    run: null,
  });
  expect(requests).toHaveLength(3);
  expect(requests[1]).toContain('第一次为什么更快？');
  expect(requests[2]).toContain('第二次画个流程图。');

  await panel.locator('.diagram-canvas').click();
  const viewer = panel.getByRole('dialog', { name: '放大看图' });
  await expect(viewer.locator('.viewer-canvas svg')).toBeVisible();
  await viewer.getByRole('button', { name: '放大' }).click();
  await expect(viewer.locator('.viewer-scale')).toHaveText('140%');
  const stage = viewer.locator('.viewer-stage');
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  await panel.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await panel.mouse.down();
  await panel.mouse.move(box!.x + box!.width / 2 + 45, box!.y + box!.height / 2 + 30);
  await panel.mouse.up();
  await expect(viewer.locator('.viewer-canvas')).toHaveAttribute('style', /translate\(45px, 30px\)/);
  await viewer.getByRole('button', { name: '复位' }).click();
  await expect(viewer.locator('.viewer-scale')).toHaveText('100%');
  if (await viewer.getByRole('button', { name: '全屏' }).isVisible()) {
    await panel.evaluate(() => {
      const shell = document.querySelector('.viewer') as HTMLElement;
      shell.requestFullscreen = () => Promise.reject(new Error('平台不允许侧栏全屏'));
    });
    await viewer.getByRole('button', { name: '全屏' }).click();
    await expect(viewer.getByRole('status')).toContainText('无法全屏');
  }
  const diagramPagePromise = context.waitForEvent('page');
  await viewer.getByRole('button', { name: '新标签页' }).click();
  const diagramPage = await diagramPagePromise;
  await expect(diagramPage).toHaveURL(`chrome-extension://${extensionId}/viewer.html`);
  await expect(diagramPage.locator('.canvas svg')).toBeVisible({ timeout: 10_000 });
  await expect(diagramPage.locator('.canvas svg')).toContainText('开始');
  await expect(diagramPage.locator('.bar')).toBeVisible();
  await diagramPage.getByRole('button', { name: '放大' }).click();
  await expect(diagramPage.locator('.bar')).toContainText('140%');
  await diagramPage.getByRole('button', { name: '复位' }).click();
  await expect(diagramPage.locator('.bar')).toContainText('100%');
  await diagramPage.setViewportSize({ width: 360, height: 720 });
  expect(await diagramPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  const fullscreen = diagramPage.getByRole('button', { name: '全屏', exact: true });
  await expect(fullscreen).toBeVisible();
  if (await diagramPage.evaluate(() => document.fullscreenEnabled)) {
    await fullscreen.click();
    await expect.poll(() => diagramPage.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('root');
    await diagramPage.getByRole('button', { name: '放大' }).click();
    await expect(diagramPage.locator('.bar')).toContainText('140%');
    const fullStage = diagramPage.locator('.stage');
    const fullBox = await fullStage.boundingBox();
    expect(fullBox).toBeTruthy();
    await diagramPage.mouse.move(fullBox!.x + fullBox!.width / 2, fullBox!.y + fullBox!.height / 2);
    await diagramPage.mouse.down();
    await diagramPage.mouse.move(fullBox!.x + fullBox!.width / 2 + 40, fullBox!.y + fullBox!.height / 2 + 25);
    await diagramPage.mouse.up();
    await expect(diagramPage.locator('.canvas')).toHaveAttribute('style', /translate\(40px, 25px\)/);
    await diagramPage.getByRole('button', { name: '复位' }).click();
    await diagramPage.getByRole('button', { name: '退出全屏' }).click();
    await expect.poll(() => diagramPage.evaluate(() => document.fullscreenElement)).toBeNull();
    await diagramPage.getByRole('button', { name: '放大' }).click();
    await expect(diagramPage.locator('.bar')).toContainText('140%');
    await diagramPage.evaluate(() => {
      document.getElementById('root')!.requestFullscreen = () => Promise.reject(new Error('拒绝全屏'));
    });
    await fullscreen.click();
    await expect(diagramPage.getByRole('status')).toContainText('无法全屏');
  } else {
    await fullscreen.click();
    await expect(diagramPage.getByRole('status')).toContainText('无法全屏');
  }
  await diagramPage.close();
  await panel.close();
  await page.close();
});
