import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';

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

type Payload = {
  blocks: { content: string }[];
  completeness: { frames: { found: number; captured: number; status: string } };
};

let context: BrowserContext;
let server: ReturnType<typeof createServer>;
let origin = '';
let crossOrigin = '';

test.describe('提取覆盖面', () => {

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      const body = request.url?.startsWith('/frame') ? FRAME : PAGE.replace('CROSS_ORIGIN_URL', crossOrigin);
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
});
