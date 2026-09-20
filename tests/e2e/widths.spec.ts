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
    references: [],
    followUps: [
      { id: 'next_0', question: '三个团队的试点为什么不能代表其他城市？', kind: 'boundary' },
      { id: 'next_1', question: '工具培训本身会不会就是时间缩短的原因？', kind: 'premise' },
    ],
    at: 0,
  },
];

const LEARNING = {
  goal: '理解这篇文章的核心内容',
  promptVersion: '2026-09-18.1',
  budget: 5,
  used: 1,
  current: {
    kind: 'open' as const,
    question: '如果你换一个城市重做这个试点，哪一点最不能照搬？',
    hintUsed: false,
  },
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

const QUIZ_CURRENT = {
  goal: '理解这篇文章的核心内容',
  promptVersion: '2026-09-18.1',
  budget: 5,
  used: 1,
  current: {
    kind: 'quiz' as const,
    questions: [
      {
        id: 'q1',
        text: '这项研究最重要的结论边界是什么？',
        multi: false,
        choices: [
          { id: 'A', label: '样本只有三个团队，不能推广到其他城市' },
          { id: 'B', label: '新方案在任何城市都快二十分钟' },
          { id: 'C', label: '工具培训没有作用' },
        ],
      },
    ],
    answerKey: [{ questionId: 'q1', answer: ['A'], why: '作者明确写了不能直接外推。' }],
  },
  status: 'active' as const,
  log: [
    {
      role: 'quiz' as const,
      text: '这项研究最重要的结论边界是什么？',
      quiz: [
        {
          id: 'q0',
          text: '这项研究处理时间的对比结果是什么？',
          multi: false,
          choices: [
            { id: 'A', label: '八十分钟对一百分钟' },
            { id: 'B', label: '一百分钟对八十分钟' },
          ],
        },
      ],
      at: 0,
    },
    {
      role: 'answer' as const,
      text: '这项研究处理时间的对比结果是什么？｜我的答案：八十分钟对一百分钟',
      independent: true,
      at: 1,
    },
    {
      role: 'feedback' as const,
      text: '本轮 1/1 题正确。\n数字对得很准。',
      graded: [{ questionId: 'q0', chosen: ['A'], correct: true }],
      score: { correct: 1, total: 1 },
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
        outbound: { version: '2026-09-19.2', acceptedAt: Date.now(), receiver: 'DeepSeek（深度求索）' },
      },
    });
  });
});

test.afterAll(async () => {
  await context?.close();
});

/**
 * 打开一个侧栏页面和一个“文章标签页”，把伪造的会话挂在文章标签页上（只测排版，不外发任何内容）。
 * 写入会话后通过临时端口发 attach 命令，让后台把最新状态推给侧栏（确定性触发，
 * 不依赖标签页切换事件的时序）。会话 url 指向 127.0.0.1，e2e 构建对该来源静态授予权限。
 */
async function openPanel(width: number): Promise<{ panel: Page; tabId: number | null }> {
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

  await pushState(panel, tabId);
  return { panel, tabId };
}

/** 通过临时端口发 attach：后台先把完整状态推给侧栏的常驻端口，再回复本端口。 */
async function pushState(panel: Page, tabId: number | null): Promise<void> {
  await panel.evaluate(async (id) => {
    await new Promise<void>((resolve) => {
      const port = chrome.runtime.connect({ name: 'webknow' });
      const requestId = Math.floor(Math.random() * 1e9);
      port.onMessage.addListener((msg) => {
        if (msg.type === 'reply' && msg.id === requestId) {
          port.disconnect();
          resolve();
        }
      });
      port.postMessage({ id: requestId, command: { type: 'attach', tabId: id } });
    });
  }, tabId);
}

test('划词会出现在提问框上面，针对这段再问', async () => {
  test.setTimeout(120_000);
  const { panel, tabId } = await openPanel(560);
  await context.serviceWorkers()[0]!.evaluate(
    async ([id]) => {
      const stored = await chrome.storage.session.get(`sess:${id}`);
      const session = stored[`sess:${id}`] as Record<string, unknown>;
      session.quote = {
        text: '新方案把平均处理时间从一百分钟降到八十分钟。',
        blockId: 'blk_2',
      };
      await chrome.storage.session.set({ [`sess:${id}`]: session });
    },
    [tabId] as const,
  );
  await pushState(panel, tabId);
  await expect(panel.getByText('针对这段原文')).toBeVisible();
  await expect(panel.getByRole('button', { name: /新方案把平均处理时间/ })).toBeVisible();
  await expect(panel.getByPlaceholder(/针对这段/)).toBeVisible();
  await panel.close();
});

test('READY 视图在三种宽度下排版正确', async () => {
  test.setTimeout(120_000);
  for (const width of WIDTHS) {
    const { panel } = await openPanel(width);
    await expect(panel.getByText('这篇文章讲了什么')).toBeVisible();
    await expect(panel.locator('.chip').first()).toBeVisible();
    // 一进来就停在顶部：摘要与话题是这一栏最重要的一段，不该被推到屏幕外。
    expect(await panel.evaluate(() => window.scrollY)).toBe(0);
    await panel.screenshot({ path: join(OUTPUT_DIR, `ready-${width}.png`), fullPage: true });
    await panel.close();
  }
});

test('点开一张卡片后开场卡全部收起，联想问题只跟在最新回答后面', async () => {
  test.setTimeout(120_000);
  const { panel, tabId } = await openPanel(560);
  // 有对话时，开场那三张不再出现；最新回答后面才是联想。
  await expect(panel.getByRole('button', { name: BUBBLES[0]!.question })).toBeHidden();
  await expect(panel.locator('.chip:visible')).toHaveCount(2);
  await expect(panel.getByText('可以接着问：')).toBeVisible();

  await context.serviceWorkers()[0]!.evaluate(async (id) => {
    const stored = await chrome.storage.session.get(`sess:${id}`);
    const session = stored[`sess:${id}`] as Record<string, unknown>;
    session.chat = [];
    await chrome.storage.session.set({ [`sess:${id}`]: session });
  }, tabId);
  await pushState(panel, tabId);
  await expect(panel.locator('.chip:visible')).toHaveCount(3);
  await expect(panel.getByText('想接着弄懂，点一张发出去：')).toBeVisible();
  await panel.close();
});

test('LEARNING 视图在宽面板下排版正确', async () => {
  test.setTimeout(120_000);
  const { panel: _panel, tabId } = await openPanel(720);
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
  await pushState(_panel, tabId);
  await expect(_panel.locator('.entry-question').first()).toBeVisible();
  await expect(_panel.getByRole('button', { name: '我不知道' })).toBeVisible();
  await _panel.screenshot({ path: join(OUTPUT_DIR, 'learning-720.png'), fullPage: true });

  // F4 的核心场景：学习进行中切回伴读，摘要、对话与输入都还在，学习不被打断。
  await _panel.getByRole('tab', { name: /^我问$/ }).click();
  await expect(_panel.getByRole('button', { name: '发送' })).toBeVisible();
  await expect(_panel.getByText('这篇文章讲了什么')).toBeVisible();
  await _panel.screenshot({ path: join(OUTPUT_DIR, 'learning-qa-tab-720.png'), fullPage: true });

  // 空闲形态：收束后回到 READY，「问我」面板显示新一轮的卡片。已经发出去的方向不再出现。
  await context.serviceWorkers()[0]!.evaluate(async (id) => {
    const stored = await chrome.storage.session.get(`sess:${id}`);
    const session = stored[`sess:${id}`] as Record<string, unknown>;
    const learning = session.learning as Record<string, unknown>;
    learning.status = 'closed';
    session.state = 'READY';
    await chrome.storage.session.set({ [`sess:${id}`]: session });
  }, tabId);
  await pushState(_panel, tabId);
  // 视图尊重用户所在的位置：收束后不会强行切走，需要自己回到「问我」。
  await _panel.getByRole('tab', { name: /^问我$/ }).click();
  await expect(_panel.getByRole('button', { name: '再来一轮' })).toBeVisible();
  await expect(_panel.getByRole('button', { name: '这篇文章的核心内容' })).toBeHidden();
  await expect(_panel.getByRole('button', { name: BUBBLES[0]!.question })).toBeVisible();
  await _panel.screenshot({ path: join(OUTPUT_DIR, 'learning-closed-720.png'), fullPage: true });

  await _panel.close();
});

test('选择题轮在宽面板下可交互', async () => {
  test.setTimeout(120_000);
  const { panel: quizPanel, tabId: quizTabId } = await openPanel(720);
  await context.serviceWorkers()[0]!.evaluate(
    async ([id, learning]) => {
      const stored = await chrome.storage.session.get(`sess:${id}`);
      const session = stored[`sess:${id}`] as Record<string, unknown>;
      session.learning = learning;
      session.state = 'LEARNING';
      await chrome.storage.session.set({ [`sess:${id}`]: session });
    },
    [quizTabId, QUIZ_CURRENT] as const,
  );
  await pushState(quizPanel, quizTabId);
  await expect(quizPanel.locator('.quiz-question').first()).toBeVisible();

  // 勾选一个选项后提交按钮才可用。
  const submit = quizPanel.getByRole('button', { name: '提交答案' });
  await expect(submit).toBeDisabled();
  await quizPanel.getByRole('radio').first().check();
  await expect(submit).toBeEnabled();
  await quizPanel.screenshot({ path: join(OUTPUT_DIR, 'quiz-720.png'), fullPage: true });

  await quizPanel.close();
});

test('设置是独立标签页：分类导航与内容区排版正确', async () => {
  test.setTimeout(120_000);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 720, height: 920 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // 设置不在侧栏里展开：非工作时的界面不该被侧栏宽度限制。
  const [settings] = await Promise.all([
    context.waitForEvent('page'),
    panel.getByRole('button', { name: '设置' }).click(),
  ]);
  await settings.setViewportSize({ width: 1100, height: 900 });
  await expect(settings).toHaveURL(/options\.html/);

  // 左侧分类导航可切换，右侧内容随分类变化。
  await expect(settings.getByLabel('「问我」一轮最多问几个问题')).toBeVisible();
  const nav = settings.getByRole('navigation', { name: '设置分类' });
  // 这台浏览器里已经有钥匙（beforeAll 放的），所以模型这一步直接可选。
  await nav.getByRole('button', { name: '模型' }).click();
  await expect(nav.getByRole('button', { name: '模型' })).toHaveAttribute('aria-current', 'true');
  await expect(settings.getByRole('heading', { name: '模型' })).toBeVisible();
  await expect(settings.getByRole('radiogroup', { name: '用哪家' }).getByRole('radio', { name: 'DeepSeek' })).toBeVisible();
  await expect(settings.getByRole('radiogroup', { name: '用哪家' }).getByRole('radio', { name: '智谱' })).toBeVisible();
  await expect(settings.getByLabel('DeepSeek 的钥匙已保存')).toBeVisible();
  await expect(settings.getByLabel('用哪个模型')).toBeVisible();
  // 提示词：选“自己写”必须立刻出现输入框——没保存过自写内容时也不能点了没反应。
  await nav.getByRole('button', { name: '提示词' }).click();
  await expect(settings.getByLabel('导读摘要：我自己写的写法')).toBeHidden();
  await settings.getByRole('radiogroup', { name: '导读摘要' }).getByRole('radio', { name: '自己写' }).click();
  await expect(settings.getByLabel('导读摘要：我自己写的写法')).toBeVisible();

  await nav.getByRole('button', { name: '知识库' }).click();
  await expect(settings.getByText('Client ID')).toBeVisible();
  await settings.screenshot({ path: join(OUTPUT_DIR, 'settings-page.png'), fullPage: true });

  await settings.close();
  await panel.close();
});

test('模式切换是完整的 tab 组件：ARIA 关系与方向键都能用', async () => {
  test.setTimeout(120_000);
  const { panel } = await openPanel(560);
  const readTab = panel.getByRole('tab', { name: /我问/ });
  const learnTab = panel.getByRole('tab', { name: /问我/ });
  const readPanel = panel.getByRole('tabpanel', { name: /我问/ });
  const learnPanel = panel.getByRole('tabpanel', { name: /问我/ });

  // 关系成套：tab 指到面板，面板指回 tab，未选中的那个真隐藏（不是只换个颜色）。
  await expect(readTab).toHaveAttribute('aria-controls', 'mode-panel-qa');
  await expect(readPanel).toHaveAttribute('id', 'mode-panel-qa');
  await expect(learnPanel).toBeHidden();
  // roving tabIndex：Tab 键只停在当前模式上，不把两个都过一遍。
  await expect(readTab).toHaveAttribute('tabindex', '0');
  await expect(learnTab).toHaveAttribute('tabindex', '-1');

  // 方向键切换并把焦点带过去（WAI-ARIA tabs 的自动激活约定）。
  await readTab.focus();
  await readTab.press('ArrowRight');
  await expect(learnTab).toHaveAttribute('aria-selected', 'true');
  await expect(learnTab).toBeFocused();
  await expect(learnPanel).toBeVisible();
  await expect(readPanel).toBeHidden();

  await learnTab.press('ArrowLeft');
  await expect(readTab).toHaveAttribute('aria-selected', 'true');
  await expect(readTab).toBeFocused();

  await learnTab.press('Home');
  await expect(readTab).toHaveAttribute('aria-selected', 'true');
  await expect(readTab).toBeFocused();

  await readTab.press('End');
  await expect(learnTab).toHaveAttribute('aria-selected', 'true');
  await expect(learnTab).toBeFocused();

  await panel.close();
});

test('深色模式跟随系统配色', async () => {
  test.setTimeout(120_000);
  const { panel } = await openPanel(560);
  await panel.emulateMedia({ colorScheme: 'dark' });
  await expect(panel.getByText('这篇文章讲了什么')).toBeVisible();
  // 深色不是把浅色反相：只断言"确实变暗了"，具体色值交给令牌本身。
  expect(await isDark(panel, 'body')).toBe(true);
  expect(await isDark(panel, '.bubble-guide')).toBe(true);
  await panel.screenshot({ path: join(OUTPUT_DIR, 'ready-560-dark.png'), fullPage: true });
  await panel.close();
});

function isDark(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const parts = getComputedStyle(el).backgroundColor.match(/\d+/g)?.map(Number) ?? [];
    const [r, g, b] = parts;
    return r !== undefined && g !== undefined && b !== undefined && (r + g + b) / 3 < 90;
  }, selector);
}

test('吸顶的两条不重叠也不漏缝', async () => {
  test.setTimeout(120_000);
  const { panel } = await openPanel(560);
  // 压低视口逼出滚动，再滚下去让两条都进入吸住的状态，然后量接缝。
  await panel.setViewportSize({ width: 560, height: 360 });
  await panel.evaluate(() => window.scrollTo(0, 600));
  expect(await panel.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  const header = await panel.locator('.panel-header').boundingBox();
  const modes = await panel.locator('.modes').boundingBox();
  expect(header!.y).toBe(0);
  expect(modes!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
  expect(modes!.y).toBeLessThanOrEqual(header!.y + header!.height + 1);
  await panel.close();
});

test('三种宽度、两个模式下都不出现横向溢出', async () => {
  test.setTimeout(180_000);
  for (const width of WIDTHS) {
    const { panel, tabId } = await openPanel(width);
    await expect(panel.getByText('这篇文章讲了什么')).toBeVisible();
    // 侧栏宽度是用户拖出来的，任何宽度都不能出现横向滚动条。
    expect(await overflowPx(panel)).toBe(0);

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
    await pushState(panel, tabId);
    await panel.getByRole('tab', { name: /问我/ }).click();
    await expect(panel.locator('.timeline').first()).toBeVisible();
    expect(await overflowPx(panel)).toBe(0);

    // 长正文与长问题在窄栏里要换行，不能把输入区顶出屏幕。
    expect(await overflowPx(panel, '.dock')).toBe(0);
    await panel.close();
  }
});

/** 横向溢出的像素数（>0 就是出现了横向滚动）。 */
function overflowPx(page: Page, selector?: string): Promise<number> {
  return page.evaluate((sel) => {
    const target = sel ? document.querySelector(sel) : document.documentElement;
    if (!target) return -1;
    return target.scrollWidth - target.clientWidth;
  }, selector);
}

test('设置：出题方式改完立刻落盘（真实存储）', async () => {
  test.setTimeout(120_000);
  const settings = await context.newPage();
  await settings.setViewportSize({ width: 1100, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/options.html`);

  // 回归：这个下拉在界面上一直存在，但后台曾经没把它写进配置，选了等于没选。
  await settings.getByRole('radiogroup', { name: '「问我」怎么出题' }).getByRole('radio', { name: '选择题' }).click();
  await expect
    .poll(async () =>
      context.serviceWorkers()[0]!.evaluate(async () => {
        const stored = await chrome.storage.local.get('config');
        return (stored.config as { learningStyle?: string } | undefined)?.learningStyle ?? null;
      }),
    )
    .toBe('quiz');

  await settings.reload();
  await expect(
    settings.getByRole('radiogroup', { name: '「问我」怎么出题' }).getByRole('radio', { name: '选择题' }),
  ).toHaveAttribute('aria-checked', 'true');
  await settings.close();
});

test('设置：窄窗口下分类导航变成横向可滚动条，正文不横溢', async () => {
  test.setTimeout(120_000);
  const settings = await context.newPage();
  await settings.setViewportSize({ width: 480, height: 820 });
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(settings.getByLabel('「问我」一轮最多问几个问题')).toBeVisible();

  // 导航占满一行并且自己能横向滚动，正文区不跟着一起横溢。
  const nav = settings.getByRole('navigation', { name: '设置分类' });
  const navBox = await nav.boundingBox();
  expect(navBox?.width).toBeGreaterThan(400);
  expect(await nav.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await settings.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480);

  // 跳转链接在窄布局下才有意义：Tab 第一下就能越过导航直达正文。
  await settings.keyboard.press('Tab');
  await expect(settings.getByRole('link', { name: '跳到设置内容' })).toBeFocused();

  await nav.getByRole('button', { name: '关于' }).click();
  await expect(settings.getByRole('heading', { name: '关于' })).toBeVisible();
  await settings.screenshot({ path: join(OUTPUT_DIR, 'settings-narrow.png'), fullPage: true });
  await settings.close();
});

test('模型：钥匙保存后掩码显示；没钥匙不给模型选择器', async () => {
  test.setTimeout(120_000);
  const settings = await context.newPage();
  await settings.setViewportSize({ width: 1100, height: 900 });
  const openModelCategory = async () => {
    await settings.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '模型' }).click();
  };
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  await openModelCategory();

  // beforeAll 已经放了 DeepSeek 钥匙：只显示掩码，可以选模型，不再露出原文。
  await expect(settings.getByLabel('DeepSeek 的钥匙已保存')).toBeVisible();
  await expect(settings.getByRole('textbox', { name: 'DeepSeek 的钥匙' })).toHaveCount(0);
  await expect(settings.getByLabel('用哪个模型')).toBeVisible();

  // 切到还没配的智谱：出现填钥匙，模型选择器消失。
  await settings.getByRole('radiogroup', { name: '用哪家' }).getByRole('radio', { name: '智谱' }).click();
  await expect(settings.getByRole('textbox', { name: '智谱 的钥匙' })).toBeVisible();
  await expect(settings.getByRole('button', { name: '保存' })).toBeVisible();
  await expect(settings.getByLabel('用哪个模型')).toHaveCount(0);

  // 清掉钥匙：回到 DeepSeek 也是填钥匙这一步。
  await context.serviceWorkers()[0]!.evaluate(() => chrome.storage.local.clear());
  await settings.reload();
  await openModelCategory();
  await expect(settings.getByRole('textbox', { name: 'DeepSeek 的钥匙' })).toBeVisible();
  await expect(settings.getByLabel('用哪个模型')).toHaveCount(0);
  await settings.screenshot({ path: join(OUTPUT_DIR, 'settings-page-connect.png'), fullPage: true });

  await settings.close();
});
