import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 联网搜索在问答里的可达性回归（F3）。
 *
 * 缺陷本体：界面发了 `search: true`，router 组装 Intent 时把这个字段丢了，
 * 于是问答里的联网开关是个死开关——打开也没有任何搜索发生，而且不留痕迹。
 *
 * 这里用一个本地假 SearXNG 把"搜索到底发出去没有"变成可观测事实：请求打到本地端口
 * 就算通过。模型调用不在断言范围内（用假 Key，一定失败），本用例只验证搜索这一步，
 * 且不发任何真实外网请求。
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');

const BLOCKS = [
  { id: 'blk_1', role: 'heading', content: '城市配送试点研究', headingPath: [] },
  {
    id: 'blk_2',
    role: 'paragraph',
    content: '本研究观察三个配送团队四周，比较新的路径方案与原有方案的处理时间。',
    headingPath: [],
  },
];

const FIXTURE_SESSION = {
  id: 's_search',
  url: 'http://127.0.0.1/article.html',
  title: '城市配送试点研究',
  fingerprint: 'search-fixture',
  state: 'READY',
  blocks: BLOCKS,
  completeness: {
    scope: 'readability-article',
    text: { status: 'parsed', found: 2, captured: 2 },
    tables: { status: 'not-present', found: 0, captured: 0 },
    images: { status: 'not-present', found: 0, captured: 0 },
    frames: { status: 'not-present', found: 0, captured: 0 },
    excludedBlocks: 0,
    truncated: false,
    warnings: [],
  },
  guide: {
    summary: '试点四周后，新方案把平均处理时间从一百分钟降到八十分钟。',
    bubbles: [{ id: 'bub_0', question: '样本只有三个团队意味着什么？', kind: 'boundary' }],
  },
  chat: [],
};

let context: BrowserContext;
let extensionId: string;
let server: Server;
let baseUrl: string;
/** 假搜索实例收到的查询词；空数组 = 搜索请求根本没发出来。 */
const hits: string[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    hits.push(url.searchParams.get('q') ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        results: [{ title: '配送路径研究综述', url: 'https://example.com/review', content: '外部资料摘要。' }],
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('假搜索实例没起来');
  baseUrl = `http://127.0.0.1:${address.port}`;

  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-search-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: 560, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;

  await worker.evaluate(
    async ([searxUrl]) => {
      await chrome.storage.local.set({
        config: {
          apiKey: 'sk-test-not-real',
          outbound: { version: '2026-09-19.2', acceptedAt: Date.now(), receiver: 'DeepSeek（深度求索）' },
          search: { providerId: 'searxng', credentials: { searxng: { baseUrl: searxUrl } } },
        },
      });
    },
    [baseUrl] as const,
  );
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((done) => server.close(() => done()));
});

const worker = () => context.serviceWorkers()[0]!;

async function openPanel(): Promise<Page> {
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 560, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const article = await context.newPage();
  await article.goto('about:blank');
  await article.bringToFront();
  const tabId = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
  });

  await worker().evaluate(
    async ([id, session]) => {
      await chrome.storage.session.set({
        [`sess:${id}`]: { ...session, tabId: id, learning: null, updatedAt: Date.now() },
      });
    },
    [tabId, FIXTURE_SESSION] as const,
  );

  await panel.evaluate(async (id) => {
    await new Promise<void>((done) => {
      const port = chrome.runtime.connect({ name: 'webknow' });
      const requestId = Math.floor(Math.random() * 1e9);
      port.onMessage.addListener((msg) => {
        if (msg.type === 'reply' && msg.id === requestId) {
          port.disconnect();
          done();
        }
      });
      port.postMessage({ id: requestId, command: { type: 'attach', tabId: id } });
    });
  }, tabId);

  return panel;
}

/** 打开开关、提问、发送。什么时候算"这轮跑完了"由各用例自己等。 */
async function ask(panel: Page, question: string, withSearch: boolean): Promise<void> {
  const toggle = panel.getByRole('button', { name: '联网搜索' });
  // 开关只在配置了搜索供应商时出现；它出现了才说明那份配置已经被读到了。
  await expect(toggle).toBeVisible();
  const pressed = (await toggle.getAttribute('aria-pressed')) === 'true';
  if (withSearch !== pressed) await toggle.click();

  await panel.getByLabel('向这篇文章提问').fill(question);
  await panel.getByRole('button', { name: '发送' }).click();
}

test('问答里的联网开关真的会把搜索发出去', async () => {
  test.setTimeout(120_000);
  hits.length = 0;
  const panel = await openPanel();
  await ask(panel, '新方案为什么更快？', true);

  // 直接等那次搜索落地。搜索排在模型调用之前，所以即使这次模型调用因为假 Key
  // 必定失败，搜索请求也已经打出去了——这正是缺陷版本里永远不会发生的事。
  await expect.poll(() => hits.length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(hits[0]).toContain('新方案为什么更快');
  await panel.close();
});

test('设置里免 Key 的搜索排在前面，选中后不要任何凭证', async () => {
  test.setTimeout(120_000);
  const settings = await context.newPage();
  await settings.setViewportSize({ width: 1100, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  await settings.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '联网搜索' }).click();

  const group = settings.getByRole('radiogroup', { name: '搜索服务' });
  const radios = group.getByRole('radio');
  // 第一张是「先不查网上」，免 Key 的从第二张起：Firecrawl、Bing、DuckDuckGo，然后才是自备服务。
  await expect(radios.nth(1)).toContainText(/Firecrawl/);
  await expect(radios.nth(1)).toContainText(/免费/);
  await expect(radios.nth(2)).toContainText(/Bing/);
  await expect(radios.nth(3)).toContainText(/DuckDuckGo/);
  await expect(radios.nth(4)).toContainText(/SearXNG/);

  await radios.nth(1).click();
  await expect(settings.getByText(/不用注册也不用填任何东西/)).toBeVisible();
  await expect(settings.getByLabel('API Key')).toBeHidden();
  await expect(settings.getByLabel('实例地址')).toBeHidden();
  await expect(settings.getByRole('button', { name: '授权并启用' })).toBeEnabled();

  await group.getByRole('radio', { name: /Tavily/ }).click();
  await expect(settings.getByLabel('API Key')).toBeVisible();

  await settings.close();
});

test('开关没打开时不发搜索', async () => {
  test.setTimeout(120_000);
  hits.length = 0;
  const panel = await openPanel();
  await ask(panel, '不联网的问题', false);

  // 假 Key 必然换来一条报错：它出现就说明这一轮从头跑到尾了。
  // 搜索排在模型调用之前，此刻还没有搜索请求，就是真的没有发。
  await expect(panel.locator('.banner-error')).toBeVisible({ timeout: 30_000 });
  expect(hits).toHaveLength(0);
  await panel.close();
});
