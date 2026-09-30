import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import type { DomAnchor } from '../../src/core/blocks';

/**
 * 正文提取的覆盖面：主文档、开放 shadow root、同源 iframe 都要读到；
 * 跨来源 iframe 读不到，必须如实计数。
 *
 * 直接用内容脚本协议取回提取结果，因此是确定性的、不调用模型。
 * jsdom 测不了这些（没有真实框架语义），所以这条只能在真浏览器里跑。
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');

const SURROUNDING = `
  <h1>城市配送试点研究</h1>
  <p>本研究观察三个配送团队四周，比较新的路径方案与原有方案的处理时间，覆盖多个城市。</p>`;

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>提取覆盖面</title></head>
<body><nav>首页 产品</nav><main><article>
${SURROUNDING}
<div id="widget"></div>
<iframe id="sameOrigin" src="/frame.html"></iframe>
<iframe id="crossOrigin" src="CROSS_ORIGIN_URL"></iframe>
<p>该结果仅来自三个已完成工具培训的团队，不能直接外推到其他城市或更长周期，需要更多观察。</p>
</article></main>
<script>
  const host = document.getElementById('widget');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<h2>组件里的小标题</h2><p>这段文字位于开放 shadow root 内部，提取时必须能读到它。</p>';
</script>
</body></html>`;

const FRAME = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>内嵌框架</title></head>
<body><article><p>这段文字位于同源 iframe 内部，提取时同样必须能读到它，否则会漏掉正文。</p></article></body></html>`;

const WECHAT = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>公众号正文</title></head>
<body><h1 id="activity-name">正文外的文章标题</h1><div id="js_content">
<p>第一段正文完整说明了试点条件，只有三个团队参与，观察期为四周。</p>
<section><span>这段证据位于微信小节中，说明新方案只在本次试点内缩短了处理时间。</span></section>
<h2>适用边界</h2><p>样本不足以代表全部组织，因此不能把结果推广到其他城市。</p>
</div><nav><p>这段导航位于正文之外，回跳不能把它当成上下文。</p></nav></body></html>`;

type Payload = {
  blocks: { content: string; anchor: DomAnchor }[];
  completeness: { frames: { found: number; captured: number; status: string } };
};

let context: BrowserContext;
let server: ReturnType<typeof createServer>;
let origin = '';
let crossOrigin = '';

test.describe('提取覆盖面', () => {

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      const body = request.url?.startsWith('/frame')
        ? FRAME
        : request.url?.startsWith('/wechat')
          ? WECHAT
          : PAGE.replace('CROSS_ORIGIN_URL', crossOrigin);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(body);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    origin = `http://127.0.0.1:${port}`;
    // 同一个服务器，用 localhost 访问就是另一个来源（跨来源 iframe）。
    crossOrigin = `http://localhost:${port}/frame.html`;

    context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-extract-')), {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
  });

  test.afterAll(async () => {
    await context?.close();
    server?.close();
  });

  test('读到 shadow root 与同源 iframe，跨来源框架如实计数', async () => {
    const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const manifestPermissions = await worker.evaluate(
      () => chrome.runtime.getManifest().host_permissions ?? [],
    );
    test.skip(
      !manifestPermissions.includes('http://127.0.0.1/*'),
      '需要 e2e 模式构建：pnpm build:e2e',
    );

    const page = await context.newPage();
    await page.goto(`${origin}/page.html`);
    // 框架必须加载完成，否则提取时 contentDocument 还是空的。
    await page.frameLocator('#sameOrigin').locator('p').waitFor();

    const tabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.id ?? null;
    });
    if (tabId === null) throw new Error('缺少标签页');

    const reply = await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['/content-scripts/content.js'] });
      return await chrome.tabs.sendMessage(id, { type: 'extract' });
    }, tabId as number);

    expect(reply).toMatchObject({ ok: true });
    const payload = (reply as { data: Payload }).data;
    const contents = payload.blocks.map((block) => block.content);

    expect(contents.some((text) => text.includes('shadow root 内部'))).toBe(true);
    expect(contents.some((text) => text.includes('同源 iframe 内部'))).toBe(true);
    expect(contents.some((text) => text.includes('三个已完成工具培训的团队'))).toBe(true);

    // 跨来源框架读不到，但必须计数并披露（不假装覆盖全文）。
    expect(payload.completeness.frames.found).toBe(2);
    expect(payload.completeness.frames.captured).toBe(1);
    expect(payload.completeness.frames.status).toBe('partial');
    await page.close();
  });

  test('公众号正文里的引用能在真实浏览器回跳，高亮原段落', async () => {
    const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    await page.goto(`${origin}/wechat.html`);

    const tabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.id ?? null;
    });
    if (tabId === null) throw new Error('缺少标签页');

    const reply = await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['/content-scripts/content.js'] });
      return chrome.tabs.sendMessage(id, { type: 'extract' });
    }, tabId);
    expect(reply).toMatchObject({ ok: true });
    const payload = (reply as { data: Payload }).data;
    const block = payload.blocks.find((item) => item.content.includes('这段证据位于微信小节中'));
    if (!block) throw new Error('缺少目标正文块');

    const jump = await worker.evaluate(async ({ id, anchor }) => {
      return chrome.tabs.sendMessage(id, { type: 'jump', anchor });
    }, { id: tabId, anchor: block.anchor });
    expect(jump).toMatchObject({ ok: true, data: { outcome: 'jumped' } });
    await expect(page.locator('.wka-evidence-highlight')).toHaveText(block.content);
    await page.close();
  });

  test('点击侧栏里的看看原文会经后台定位公众号正文', async () => {
    const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        config: {
          apiKeys: { deepseek: 'sk-test-not-real' },
          outbound: { version: '2026-09-19.2', acceptedAt: Date.now(), receiver: 'DeepSeek（深度求索）' },
        },
      });
    });
    let requests = 0;
    await context.route('https://api.deepseek.com/chat/completions', async (route) => {
      const output = requests++ === 0
        ? { summary: '本文说明了试点条件和适用边界。', bubbles: [] }
        : {
            answer: '新方案只在本次试点内缩短了处理时间。',
            source: 'original',
            citations: ['b_1'],
            unanswered: [],
            followUps: [],
          };
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      });
    });

    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const page = await context.newPage();
    await page.goto(`${origin}/wechat.html`);
    await page.bringToFront();
    const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null);
    if (tabId === null) throw new Error('缺少标签页');
    await worker.evaluate(async ([id, url, org]) => {
      await chrome.storage.session.set({ [`pending:${id}`]: { url, origin: org, at: Date.now() } });
    }, [tabId, `${origin}/wechat.html`, origin] as const);
    await panel.reload();
    await panel.getByRole('button', { name: '开始阅读' }).click();
    await expect(panel.getByText('本文说明了试点条件和适用边界。')).toBeVisible({ timeout: 20_000 });

    await panel.getByLabel('向这篇文章提问').fill('试点结果适用于哪里？');
    await panel.getByRole('button', { name: '发送' }).click();
    await panel.getByRole('button', { name: '看看原文1' }).click();
    await expect(page.locator('#js_content .wka-evidence-highlight')).toHaveText(
      '这段证据位于微信小节中，说明新方案只在本次试点内缩短了处理时间。',
    );
    expect(requests).toBe(2);
    await panel.close();
    await page.close();
  });
});
