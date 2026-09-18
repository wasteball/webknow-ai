import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * 侧栏宽度自适应验证（产品化改造 F1）：
 * 侧栏宽度由用户拖动浏览器分隔线决定（Chrome 自己记住），界面必须适应任意宽度。
 * 本用例在 360 / 560 / 720px 三种宽度下渲染同一份“已就绪”会话并截图，
 * 供人工核对排版；不调用模型，无 Key 也可跑。
 *
 *   pnpm build:e2e && npx playwright test tests/e2e/widths.spec.ts
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');
const OUTPUT_DIR = resolve(process.cwd(), 'test-results/widths');
const WIDTHS = [360, 560, 720] as const;

const SUMMARY =
  '这项研究比较了新的配送路径方案与原有方案：试点四周后，新方案把平均处理时间从一百分钟降到八十分钟。' +
  '但作者明确提醒，样本只有三个经过培训的团队，结论不能直接推广到其他城市或更长周期。';

const BUBBLES = [
  { id: 'bub_0', question: '为什么三个团队的试点不能代表其他城市？', kind: 'boundary' },
  { id: 'bub_1', question: '处理时间减少了二十分钟，可能来自哪些环节？', kind: 'reason' },
  { id: 'bub_2', question: '工具培训本身会不会就是时间缩短的原因？', kind: 'premise' },
];

const CHAT = [
  {
    id: 't_1',
    question: '新方案为什么更快？',
    answer:
      '文章把更快归因于新的路径方案，但没有拆解具体是哪个环节省下的时间。' +
      '作者只提到三个团队都完成了工具培训，因此无法排除培训本身的影响。',
    source: 'original',
    citations: [{ blockId: 'blk_2' }],
    unanswered: ['具体是装载还是行驶环节省了时间，正文没有说。'],
    at: 0,
  },
];

const LEARNING = {
  goal: '理解这篇文章的核心内容',
  promptVersion: '2026-09-18.1',
  used: 1,
  current: { question: '如果你换一个城市重做这个试点，哪一点最不能照搬？', hintUsed: false },
  status: 'active' as const,
  log: [
    { role: 'question' as const, text: '这项研究里，新方案比原方案快了多少？', at: 0 },
    { role: 'answer' as const, text: '快了二十分钟，从一百分钟降到八十分钟。', independent: true, at: 1 },
    {
      role: 'feedback' as const,
      text: '对，数字说对了。下一步我们看看这个结论的边界。',
      verdict: 'correct' as const,
      at: 2,
    },
  ],
};

const BLOCKS = [
  { id: 'blk_1', role: 'heading', content: '城市配送试点研究', headingPath: [] },
  {
    id: 'blk_2',
    role: 'paragraph',
    content:
      '本研究观察三个配送团队四周，比较新的路径方案与原有方案的处理时间。试点期间，新方案的平均处理时间为八十分钟，原方案为一百分钟。',
    headingPath: ['主要发现'],
  },
  {
    id: 'blk_3',
    role: 'paragraph',
    content: '该结果仅来自三个已完成工具培训的团队，不能直接外推到其他城市或更长周期。',
    headingPath: ['主要发现'],
  },
];

const COMPLETENESS = {
  scope: 'readability-article',
  text: { status: 'parsed', found: 3, captured: 3 },
  tables: { status: 'not-present', found: 0, captured: 0 },
  images: { status: 'not-present', found: 0, captured: 0 },
  frames: { status: 'not-present', found: 0, captured: 0 },
  excludedBlocks: 0,
  truncated: false,
  warnings: [],
};

/** 伪造的“已就绪”会话体：evaluate 回调在后台作用域执行，模块常量必须作为参数传入。 */
const FIXTURE_SESSION = {
  id: 's_width',
  url: 'http://127.0.0.1/article.html',
  title: '城市配送试点研究',
  fingerprint: 'width-fixture',
  state: 'READY',
  blocks: BLOCKS,
  completeness: COMPLETENESS,
  guide: { summary: SUMMARY, bubbles: BUBBLES },
  chat: CHAT,
};

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-width-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: 400, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;

  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      config: {
        apiKey: 'sk-test-not-real',
        outbound: { version: '2026-09-18.1', acceptedAt: Date.now(), receiver: 'DeepSeek（深度求索）' },
      },
    });
  });
});

test.afterAll(async () => {
  await context?.close();
});

/**
 * 打开一个侧栏页面和一个“文章标签页”，把伪造的会话挂在文章标签页上（只测排版，不外发任何内容）。
 * 侧栏通过 tabs.onActivated 重新取状态，因此最后用一次标签页切换触发状态推送；
 * 不能 reload 侧栏页面本身——导航守卫会把它自己标签页上的会话判为陈旧。
 * 会话 url 指向 127.0.0.1，e2e 构建对该来源静态授予权限，因此相位推导为 READY。
 */
async function openPanel(width: number): Promise<{ panel: Page; article: Page }> {
  const panel = await context.newPage();
  await panel.setViewportSize({ width, height: 920 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const article = await context.newPage();
  await article.goto('about:blank');
  await article.bringToFront();
  // tabs.query 只能在扩展上下文调用；文章页在前台时，侧栏里查到的活动标签页就是文章页。
  const tabId = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
  });

  await context.serviceWorkers()[0]!.evaluate(
    async ([id, session]) => {
      await chrome.storage.session.set({
        [`sess:${id}`]: { ...session, tabId: id, learning: null, updatedAt: Date.now() },
      });
    },
    [tabId, FIXTURE_SESSION] as const,
  );

  // 切走再切回来，让侧栏的 onActivated 监听重新 attach 文章标签页并推送新状态。
  await panel.bringToFront();
  await article.bringToFront();
  return { panel, article };
}

/** 切换一次活动标签页，让侧栏重新读取存储里的会话。 */
async function refreshPanel(panel: Page, article: Page): Promise<void> {
  await panel.bringToFront();
  await article.bringToFront();
}

test('READY 视图在三种宽度下排版正确', async () => {
  test.setTimeout(120_000);
  for (const width of WIDTHS) {
    const { panel, article } = await openPanel(width);
    await expect(panel.getByText('这篇文章讲了什么')).toBeVisible();
    await expect(panel.locator('.bubble').first()).toBeVisible();
    await panel.screenshot({ path: join(OUTPUT_DIR, `ready-${width}.png`), fullPage: true });
    await panel.close();
    await article.close();
  }
});

test('LEARNING 视图在宽面板下排版正确', async () => {
  test.setTimeout(120_000);
  const { panel, article } = await openPanel(720);
  const tabId = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
  });
  await context.serviceWorkers()[0]!.evaluate(
    async ([id, learning]) => {
      const stored = await chrome.storage.session.get(`sess:${id}`);
      const session = stored[`sess:${id}`] as Record<string, unknown>;
      session.learning = learning;
      session.state = 'LEARNING';
      await chrome.storage.session.set({ [`sess:${id}`]: session });
    },
    [tabId, LEARNING] as const,
  );
  await refreshPanel(panel, article);
  await expect(panel.locator('.entry-question').first()).toBeVisible();
  await panel.screenshot({ path: join(OUTPUT_DIR, 'learning-720.png'), fullPage: true });
  await panel.close();
  await article.close();
});
