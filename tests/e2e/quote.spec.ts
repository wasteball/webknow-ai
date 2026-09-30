import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 划词提问的真实浏览器验证：在网页上真的划一段、真的点「引用提问」，
 * 然后看后台会话里有没有这段引用。
 *
 * 这条用例存在的理由：这个功能在 jsdom 里一直是绿的，真实 Chrome 里却点了没反应。
 * 只有真浏览器能同时暴露内容脚本注入、消息通道和后台写入这三段。
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');

const FIXTURE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>城市配送试点研究</title></head>
<body><main><article>
<h1>城市配送试点研究</h1>
<p id="p1">本研究观察三个配送团队四周，比较新的路径方案与原有方案的处理时间。</p>
<p id="p2">试点期间，新方案的平均处理时间为八十分钟，原方案为一百分钟。</p>
</article></main></body></html>`;

test.describe('划词提问', () => {
  let context: BrowserContext;
  let extensionId: string;
  let article: Page;
  let origin: string;
  let server: ReturnType<typeof createServer>;
  let tabId: number;

  test.beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(FIXTURE);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-quote-')), {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(worker.url()).host;
    void extensionId;

    article = await context.newPage();
    await article.goto(`${origin}/article.html`);
    await article.bringToFront();

    const helper = await context.newPage();
    await helper.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const id = await helper.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
      return tabs[0]?.id ?? null;
    });
    await helper.close();
    if (id === null) throw new Error('找不到文章标签页');
    tabId = id;
  });

  test.afterAll(async () => {
    await context?.close();
    server?.close();
  });

  test('划一段再点引用提问，后台会话里出现这段引用', async () => {
    const worker = context.serviceWorkers()[0];
    if (!worker) throw new Error('缺少 service worker');
    const manifestPermissions = await worker.evaluate(() => chrome.runtime.getManifest().host_permissions ?? []);
    test.skip(
      !manifestPermissions.includes('http://127.0.0.1/*'),
      '需要 e2e 模式构建：pnpm build:e2e',
    );

    // 预置一个 READY 会话：划词只在伴读开始之后才有意义。
    await worker.evaluate(
      async ([id, url]) => {
        await chrome.storage.session.set({
          [`sess:${id}`]: {
            tabId: id,
            url,
            title: '城市配送试点研究',
            state: 'READY',
            fingerprint: 'x',
            blocks: [
              { id: 'b1', content: '本研究观察三个配送团队四周，比较新的路径方案与原有方案的处理时间。', anchor: { selector: '#p1' } },
              { id: 'b2', content: '试点期间，新方案的平均处理时间为八十分钟，原方案为一百分钟。', anchor: { selector: '#p2' } },
            ],
            chat: [],
            learning: null,
            guide: null,
            quote: null,
            completeness: null,
            error: null,
            run: null,
            updatedAt: Date.now(),
          },
        });
      },
      [tabId, `${origin}/article.html`] as const,
    );

    // 注入内容脚本并开始听选取（产品里由「总结摘要」这一步完成）。
    await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['/content-scripts/content.js'] });
      await chrome.tabs.sendMessage(id, { type: 'watch' });
    }, tabId);

    // 真的用鼠标划过第二段。
    const paragraph = article.locator('#p2');
    const box = await paragraph.boundingBox();
    if (!box) throw new Error('取不到段落位置');
    await article.mouse.move(box.x + 2, box.y + box.height / 2);
    await article.mouse.down();
    await article.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 12 });
    await article.mouse.up();

    const host = article.locator('#wka-quote-ask');
    await expect(host).toBeAttached({ timeout: 5_000 });
    await host.locator('button').click();

    // 后台把这段写进会话，侧栏才能显示引用条。
    await expect
      .poll(
        async () =>
          worker.evaluate(async (id) => {
            const all = await chrome.storage.session.get(`sess:${id}`);
            const session = all[`sess:${id}`] as { quote?: { text?: string } | null } | undefined;
            return session?.quote?.text ?? null;
          }, tabId),
        { timeout: 10_000 },
      )
      .toContain('八十分钟');
  });
});
