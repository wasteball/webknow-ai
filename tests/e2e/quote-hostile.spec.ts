import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import { unlockPageSelection } from '../../src/content/select-unlock';

/**
 * 敌意页面上的划词提问：模仿微信公众号——正文禁止选择、页面在捕获阶段取消 selectstart、
 * 松开时清掉选区、并在 document 捕获阶段吃掉 mousedown。
 * 页面自己的监听在扩展之前注册，和真实顺序一致。
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');

const FIXTURE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>城市配送试点研究</title>
<style>#js_content,#js_content *{user-select:none;-webkit-user-select:none}</style></head>
<body><div id="js_content"><div class="rich_media_content">
<h1>城市配送试点研究</h1>
<p id="p1">本研究观察三个配送团队四周，比较新的路径方案与原有方案的处理时间。</p>
<p id="p2">试点期间，新方案的平均处理时间为八十分钟，原方案为一百分钟。</p>
</div></div>
<script>
  window.addEventListener('selectstart', (e) => e.preventDefault(), true);
  document.addEventListener('selectstart', (e) => e.preventDefault(), true);
  document.getElementById('js_content').addEventListener('selectstart', (e) => e.preventDefault());
  document.addEventListener('mousedown', (e) => e.stopPropagation(), true);
  document.addEventListener('mouseup', () => getSelection().removeAllRanges());
</script>
</body></html>`;

test.describe('敌意页面上的划词提问', () => {
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

    context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-hostile-')), {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(worker.url()).host;

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

  test('正文禁止选择、页面吃掉事件时，仍能划词并把这段发给后台', async () => {
    const worker = context.serviceWorkers()[0];
    if (!worker) throw new Error('缺少 service worker');
    const permissions = await worker.evaluate(() => chrome.runtime.getManifest().host_permissions ?? []);
    test.skip(!permissions.includes('http://127.0.0.1/*'), '需要 e2e 模式构建：pnpm build:e2e');

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

    // 产品里这两步由「总结摘要」完成：主世界放开选区 + 内容脚本开始听选取。
    // 放开选区这一段直接用产品源码，避免用例和实现走偏。
    await worker.evaluate(
      async (input: { id: number; source: string }) => {
        await chrome.scripting.executeScript({
          target: { tabId: input.id },
          world: 'MAIN',
          args: [input.source],
          func: (code: string) => {
            // 页面主世界里执行产品那段放开选区的代码。
            (0, eval)(`(${code})()`);
          },
        });
        await chrome.scripting.executeScript({ target: { tabId: input.id }, files: ['/content-scripts/content.js'] });
        await chrome.tabs.sendMessage(input.id, { type: 'watch' });
      },
      { id: tabId, source: unlockPageSelection.toString() },
    );

    const box = await article.locator('#p2').boundingBox();
    if (!box) throw new Error('取不到段落位置');
    await article.mouse.move(box.x + 2, box.y + box.height / 2);
    await article.mouse.down();
    await article.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 12 });
    await article.mouse.up();

    const host = article.locator('#wka-quote-ask');
    await expect(host).toBeAttached({ timeout: 5_000 });
    await host.locator('button').click();

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
