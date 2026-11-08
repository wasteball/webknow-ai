import { outboundFixture } from './helpers/consent';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 第一期界面验收截图：320 / 360 / 480 宽 × 浅 / 深色 × 各状态，并断言无横向溢出。
 * 只用伪造会话，不调用模型、不外发。截图在 test-results/phase1/，供逐条对照体验清单。
 *
 *   pnpm build:e2e && npx playwright test tests/e2e/phase1.spec.ts
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');
const OUT = resolve(process.cwd(), 'test-results/phase1');
const WIDTHS = [320, 360, 480] as const;

const BLOCKS = [
  { id: 'blk_1', role: 'heading', content: '城市配送试点研究', headingPath: [] },
  { id: 'blk_2', role: 'paragraph', content: '本研究观察三个配送团队四周，新方案的平均处理时间为八十分钟，原方案为一百分钟。', headingPath: [] },
  { id: 'blk_3', role: 'paragraph', content: '该结果仅来自三个已完成工具培训的团队，不能直接外推到其他城市。', headingPath: [] },
];
const COMPLETENESS = {
  scope: 'readability-article',
  textRange: { characters: 80, first: { blockId: 'blk_2', text: BLOCKS[1]!.content }, last: { blockId: 'blk_3', text: BLOCKS[2]!.content } },
  text: { status: 'parsed', found: 3, captured: 3 },
  tables: { status: 'not-present', found: 0, captured: 0 },
  images: { status: 'not-present', found: 0, captured: 0 },
  frames: { status: 'not-present', found: 0, captured: 0 },
  excludedBlocks: 0, truncated: false, warnings: [],
};
const BASE = {
  id: 's_phase1', url: 'http://127.0.0.1/article.html', title: '城市配送试点：新路径方案让处理时间缩短了一半',
  fingerprint: 'phase1', blocks: BLOCKS, completeness: COMPLETENESS,
};
const READY = {
  ...BASE, state: 'READY',
  guide: { summary: '三个团队试用新路径方案四周，每单处理时间从一百分钟降到八十分钟。\n\n但这三个团队都提前受过培训、人数也少，所以还不能说新方案在别的城市同样有效。',
    bubbles: [{ id: 'b0', question: '培训和新方案，到底是谁让速度变快的？', kind: 'reason' },
      { id: 'b1', question: '为什么三个团队的结果不能推广到别的城市？', kind: 'boundary' }] },
  chat: [{ id: 't1', question: '这里说的样本量小，到底小到什么程度？', quote: { text: '三个已完成工具培训的团队', blockId: 'blk_3' },
    answer: '只有 **3 个团队、4 周**。数据这么少，只要一个团队特别熟练，就可能把平均时间拉低，所以很难确定变快是方案本身的功劳。',
    source: 'original', citations: [{ blockId: 'blk_3' }, { blockId: 'blk_2' }], references: [],
    unanswered: ['每个团队有多少人、处理了多少单。'],
    followUps: [{ id: 'f0', question: '如果扩大到十个团队，结论会变吗？', kind: 'boundary' }], at: 1 }],
  learning: { goal: '理解这篇文章的核心内容', promptVersion: '1', used: 2, status: 'active',
    current: { kind: 'open', question: '你再看看，这三个团队在试点前做过什么？', hintUsed: false },
    log: [
      { role: 'question', text: '新方案让处理时间缩短了，作者为什么还说“不能直接推广”？', at: 0 },
      { role: 'answer', text: '因为只试了三个团队，太少了。', independent: true, at: 1 },
      { role: 'feedback', text: '对，样本少是一个原因，你抓到了。不过作者还提到另一件事，它会让人分不清到底是谁的功劳。', verdict: 'partial', mastery: 'basic', at: 2 },
      { role: 'question', text: '你再看看，这三个团队在试点前做过什么？', at: 3 },
    ] },
};

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-phase1-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: 400, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});
test.afterAll(async () => { await context?.close(); });

async function setConfig(configured: boolean) {
  await context.serviceWorkers()[0]!.evaluate(async ([on, outbound]) => {
    await chrome.storage.local.set({ config: on ? { apiKey: 'sk-test-not-real', outbound } : {} });
  }, [configured, outboundFixture()] as const);
}

async function open(width: number, scheme: 'light' | 'dark', session: Record<string, unknown> | null): Promise<Page> {
  const panel = await context.newPage();
  await panel.emulateMedia({ colorScheme: scheme });
  await panel.setViewportSize({ width, height: 760 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const article = await context.newPage();
  await article.goto('about:blank');
  await article.bringToFront();
  const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null);
  if (session) {
    await context.serviceWorkers()[0]!.evaluate(async ([id, value]) => {
      await chrome.storage.session.set({ [`sess:${id}`]: { ...value, tabId: id, updatedAt: Date.now() } });
    }, [tabId, session] as const);
  }
  await panel.evaluate(async (id) => new Promise<void>((done) => {
    const port = chrome.runtime.connect({ name: 'webknow' });
    const requestId = Math.floor(Math.random() * 1e9);
    port.onMessage.addListener((msg) => { if (msg.type === 'reply' && msg.id === requestId) { port.disconnect(); done(); } });
    port.postMessage({ id: requestId, command: { type: 'attach', tabId: id } });
  }), tabId);
  return panel;
}

async function saveSettings(panel: Page, patch: Record<string, unknown>) {
  await panel.evaluate(async (value) => new Promise<void>((done) => {
    const port = chrome.runtime.connect({ name: 'webknow' });
    const requestId = Math.floor(Math.random() * 1e9);
    port.onMessage.addListener((msg) => { if (msg.type === 'reply' && msg.id === requestId) { port.disconnect(); done(); } });
    port.postMessage({ id: requestId, command: { type: 'saveSettings', patch: value } });
  }), patch);
}

async function noOverflow(panel: Page) {
  // 抽屉/菜单有 220ms 入场位移，等动画结束再量。
  await panel.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  const overflow = await panel.evaluate(() => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > root.clientWidth + 1)
      .map((el) => `${el.tagName}.${el.className}`).slice(0, 5);
    return { scroll: root.scrollWidth - root.clientWidth, offenders };
  });
  expect(overflow.offenders, `横向溢出：${overflow.offenders.join(', ')}`).toEqual([]);
  expect(overflow.scroll).toBeLessThanOrEqual(0);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`首次使用三步（${scheme}）`, async () => {
    await setConfig(false);
    for (const width of WIDTHS) {
      const panel = await open(width, scheme, null);
      await expect(panel.getByRole('heading', { name: '哪里不懂，划哪里' })).toBeVisible();
      await noOverflow(panel);
      await panel.screenshot({ path: `${OUT}/setup-1-${width}-${scheme}.png` });
      await panel.getByRole('button', { name: '下一步' }).click();
      await expect(panel.getByRole('heading', { name: /拿一把 DeepSeek 的钥匙/ })).toBeVisible();
      await expect(panel.getByRole('link', { name: /打开 DeepSeek 官网/ })).toHaveAttribute('href', /platform\.deepseek\.com/);
      await noOverflow(panel);
      await panel.screenshot({ path: `${OUT}/setup-2-${width}-${scheme}.png` });
      await panel.close();
    }
  });

  test(`读这一页、问 AI、AI 问、⋯ 菜单、整页设置（${scheme}）`, async () => {
    await setConfig(true);
    for (const width of WIDTHS) {
      const entry = await open(width, scheme, null);
      await expect(entry.getByRole('button', { name: '开始阅读' })).toBeVisible();
      await noOverflow(entry);
      await entry.screenshot({ path: `${OUT}/entry-${width}-${scheme}.png` });
      await entry.close();

      const panel = await open(width, scheme, READY);
      // 进行中的 AI 问会默认停在 AI 问页签；先切到问 AI。
      await panel.getByRole('tab', { name: '问 AI', exact: true }).click();
      await expect(panel.getByRole('heading', { name: BASE.title })).toBeVisible();
      await expect(panel.getByRole('button', { name: '回到文中 1' })).toBeVisible();
      await noOverflow(panel);
      await panel.screenshot({ path: `${OUT}/ask-${width}-${scheme}.png` });

      // AI 问：不出现分数与判定标签
      await panel.getByRole('tab', { name: 'AI 问', exact: true }).click();
      await expect(panel.getByText('你再看看，这三个团队在试点前做过什么？').first()).toBeVisible();
      for (const label of ['对了一半', '基本理解']) await expect(panel.getByText(label, { exact: true })).toHaveCount(0);
      await noOverflow(panel);
      await panel.screenshot({ path: `${OUT}/learn-${width}-${scheme}.png` });
      await panel.getByRole('tab', { name: '问 AI', exact: true }).click();

      await panel.getByLabel('向这篇文章提问').fill('保留的草稿');
      await panel.getByRole('button', { name: '更多' }).click();
      await panel.screenshot({ path: `${OUT}/menu-${width}-${scheme}.png` });
      // 设置是整页标签页；再点一次只切过去，不多开。
      const [settings] = await Promise.all([context.waitForEvent('page'), panel.getByRole('menuitem', { name: '设置' }).click()]);
      await expect(settings).toHaveURL(/options\.html/);
      await settings.emulateMedia({ colorScheme: scheme });
      await settings.setViewportSize({ width: 1100, height: 820 });
      await settings.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '读法' }).click();
      await expect(settings.getByRole('tab', { name: '怎么总结' })).toBeVisible();
      if (width === WIDTHS[0]) await settings.screenshot({ path: `${OUT}/readway-page-${scheme}.png`, fullPage: true });
      const before = context.pages().length;
      await panel.getByRole('button', { name: '更多' }).click();
      await panel.getByRole('menuitem', { name: '设置' }).click();
      await expect.poll(() => settings.url()).toMatch(/options\.html/);
      expect(context.pages().length).toBe(before);
      await settings.close();
      // 侧栏里的草稿不受影响
      await expect(panel.getByLabel('向这篇文章提问')).toHaveValue('保留的草稿');

      // 大字号：不再用 zoom，仍不溢出
      await saveSettings(panel, { fontSize: 'large' });
      await expect(panel.locator('.panel.font-large')).toHaveCount(1);
      expect(await panel.locator('.panel').evaluate((node) => getComputedStyle(node).zoom)).toBe('1');
      await noOverflow(panel);
      await panel.screenshot({ path: `${OUT}/ask-large-${width}-${scheme}.png` });
      await saveSettings(panel, { fontSize: 'normal' });
      await panel.close();
    }
  });
}
