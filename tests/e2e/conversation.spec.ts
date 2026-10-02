import { outboundFixture } from './helpers/consent';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

const extensionPath = resolve('.output/chrome-mv3-e2e');
const articleText = '<!doctype html><title>配送试点</title><article><h1>配送试点</h1><p>本研究观察三个配送团队四周，新方案的平均处理时间为八十分钟，原方案为一百分钟。</p><p>样本只有三个经过培训的团队，不能直接推广到其他城市。</p></article>';
let context: BrowserContext; let server: Server; let origin: string; let extensionId: string;

test.beforeAll(async () => {
  server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(articleText); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-chat-')), {
    channel: 'chromium', args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).host;
  await worker.evaluate(async (outbound) => chrome.storage.local.set({ config: { apiKeys: { deepseek: 'sk-test-not-real' },
    outbound } }), outboundFixture());
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((done) => server.close(() => done())); });

async function openPanel(capturePorts = false) {
  const panel = await context.newPage(); await panel.setViewportSize({ width: 360, height: 450 });
  if (capturePorts) await panel.addInitScript(() => {
    const scope = window as unknown as { testPorts: { disconnect: () => void }[] };
    scope.testPorts = [];
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = ((...args: Parameters<typeof chrome.runtime.connect>) => {
      const port = connect(...args);
      scope.testPorts.push(port);
      return port;
    }) as typeof chrome.runtime.connect;
  });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const article = await context.newPage(); await article.goto(`${origin}/article.html`); await article.bringToFront();
  const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]!.id!);
  await context.serviceWorkers()[0]!.evaluate(async ([id, url, origin]) => chrome.storage.session.set({ [`pending:${id}`]: { url, origin, at: Date.now() } }), [tabId, `${origin}/article.html`, origin] as const);
  await panel.reload(); await panel.getByRole('button', { name: '开始阅读', exact: true }).click();
  await expect(panel.locator('.said-guide')).toBeVisible();
  return { panel, article, tabId };
}
const sse = (output: unknown) => `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

async function storedLearning(tabId: number) {
  return context.serviceWorkers()[0]!.evaluate(async (id) => {
    const key = `sess:${id}`; const data = await chrome.storage.session.get(key);
    return data[key] as { learning: { current: unknown; log: { role: string; text: string }[] }; learningHistory?: unknown[] };
  }, tabId);
}

test('真实后台保留学习历史，长选择题不挤走输入，切模式不丢草稿', async () => {
  const longChoice = '只在三个经过培训的配送团队中观察，不能直接外推到其他城市。'.repeat(6);
  const outputs = [
    { summary: '试点缩短处理时间，但样本有限。', bubbles: [] },
    { action: 'quiz', questions: [
      { id: 'q1', text: '文中有哪些适用限制？', choices: [{ id: 'A', label: longChoice }, { id: 'B', label: '所有城市都适用。' }], answer: ['A'], why: '仅三个团队。' },
    ] },
    { action: 'graded', analysis: '样本限制找对了。', notes: [], nextQuiz: null, nextQuestion: '为什么不能直接推广到其他城市？' },
    { action: 'summary', summary: '本轮已核对数字与适用范围。', nextDirections: ['再看试点周期'] },
    { action: 'question', question: '原文试点持续了多久？' },
  ];
  let calls = 0; let release = () => {}; const pause = new Promise<void>((done) => { release = done; });
  const bodies: string[] = [];
  await context.route('https://api.deepseek.com/chat/completions', async (route) => {
    const index = calls++; bodies.push(route.request().postData() ?? '');
    if (index === 1) await pause;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(outputs[index]) });
  });
  const { panel, article, tabId } = await openPanel();
  await panel.getByRole('tab', { name: 'AI 问', exact: true }).click();
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await panel.getByRole('tab', { name: '问 AI', exact: true }).click();
  const qa = panel.getByLabel('向这篇文章提问'); await qa.fill('准备下一次提问');
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  release();
  await expect.poll(async () => (await storedLearning(tabId)).learning.current !== null).toBe(true);
  await expect(panel.getByRole('tab', { name: '问 AI', exact: true })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('tab', { name: 'AI 问', exact: true }).click();
  await expect(panel.getByRole('group', { name: '文中有哪些适用限制？', exact: true })).toHaveCount(1);
  expect(await panel.locator('#mode-panel-learn .dock fieldset').count()).toBe(0);
  const submit = panel.getByRole('button', { name: '提交', exact: true }); await expect(submit).toBeDisabled();
  await panel.getByRole('radio', { name: longChoice, exact: true }).check();
  await expect(submit).toBeEnabled();
  const box = await submit.boundingBox(); expect(box!.y + box!.height).toBeLessThanOrEqual(451);
  await submit.click();
  await expect(panel.getByText('本轮 1/1 题正确。', { exact: false })).toBeVisible();
  await panel.getByLabel('用自己的话回答').fill('我还想补充一点');
  await panel.getByRole('tab', { name: '问 AI', exact: true }).click(); await expect(qa).toHaveValue('准备下一次提问');
  await panel.getByRole('tab', { name: 'AI 问', exact: true }).click(); await expect(panel.getByLabel('用自己的话回答')).toHaveValue('我还想补充一点');
  await panel.locator('.assist-more summary').click(); await panel.getByRole('button', { name: '结束', exact: true }).click();
  await expect(panel.getByText('本轮已核对数字与适用范围。')).toBeVisible();
  await panel.getByRole('button', { name: '再看试点周期', exact: true }).click();
  await expect(panel.getByText('原文试点持续了多久？', { exact: true })).toBeVisible();
  await expect(panel.getByText('本轮已核对数字与适用范围。')).toHaveCount(1);
  expect((await storedLearning(tabId)).learningHistory).toHaveLength(1);
  expect(bodies[4]).not.toContain('本轮已核对数字与适用范围。');
  await panel.close(); await article.close(); await context.unroute('https://api.deepseek.com/chat/completions');
});

test('重连恢复网页订阅，残留中断状态可重试，长对话上滑即有返回入口', async () => {
  test.setTimeout(120_000);
  let calls = 0;
  await context.route('https://api.deepseek.com/chat/completions', async (route) => {
    const index = calls++;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(index === 0
      ? { summary: '试点有明确数字。', bubbles: [] }
      : { answer: `第 ${index} 次回复：${'样本仅限三个团队，不能直接推广。'.repeat(25)}`, source: 'original', citations: ['b_1'], unanswered: [], followUps: [] }) });
  });
  const { panel, article, tabId } = await openPanel(true);
  const debugging = await context.newCDPSession(panel);
  let versionId: string | undefined;
  debugging.on('ServiceWorker.workerVersionUpdated', (event: { versions: { versionId: string; scriptURL: string }[] }) => {
    versionId = event.versions.find((version) => version.scriptURL.includes(extensionId))?.versionId ?? versionId;
  });
  await debugging.send('ServiceWorker.enable');
  await expect.poll(() => versionId).toBeTruthy();
  if (!versionId) throw new Error('找不到扩展后台 worker');
  await debugging.send('ServiceWorker.stopWorker', { versionId });
  await expect.poll(() => panel.evaluate(() => (window as unknown as { testPorts: unknown[] }).testPorts.length)).toBe(2);
  const input = panel.getByLabel('向这篇文章提问');
  await input.fill('重连后还能回复吗？');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.getByText(/第 1 次回复/)).toBeVisible();
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(async (id) => {
    const key = `sess:${id}`;
    const stored = await chrome.storage.session.get(key);
    await chrome.storage.session.set({ [key]: { ...(stored[key] as Record<string, unknown>), run: { id: 'lost-worker', kind: 'answer', startedAt: Date.now() } } });
  }, tabId);
  await panel.reload();
  await expect(panel.getByRole('alert')).toContainText('生成被中断');
  await expect(panel.getByText(/第 1 次回复/)).toHaveCount(1);
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeHidden();
  await input.fill('恢复后继续问');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.getByText(/第 2 次回复/)).toBeVisible();
  const area = panel.locator('#mode-panel-qa .chat-scroll');
  await area.evaluate((node) => { node.scrollTop = 20; node.dispatchEvent(new Event('scroll')); });
  const latest = panel.getByRole('button', { name: '回到最新消息', exact: true });
  await expect(latest).toBeVisible();
  const latestBox = await latest.boundingBox();
  const dock = await panel.locator('#mode-panel-qa .dock').boundingBox();
  expect(latestBox!.y + latestBox!.height).toBeLessThanOrEqual(dock!.y);
  await latest.click();
  await expect(latest).toBeHidden();
  await expect.poll(() => area.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
  expect(calls).toBe(3);
  await panel.close(); await article.close(); await context.unroute('https://api.deepseek.com/chat/completions');
});

test('引用发送即从输入框移出，生成期间新引用和草稿不被旧回复清掉', async () => {
  let calls = 0;
  let release!: () => void;
  const pause = new Promise<void>((resolve) => { release = resolve; });
  await context.route('https://api.deepseek.com/chat/completions', async (route) => {
    const index = calls++;
    if (index === 1) await pause;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(index === 0
      ? { summary: '试点有明确数字。', bubbles: [] }
      : { answer: '样本只有三个团队。', source: 'original', citations: ['b_1'], unanswered: [], followUps: [] }) });
  });
  const { panel, article, tabId } = await openPanel();
  const input = panel.getByLabel('向这篇文章提问');
  const select = async (text: string) => panel.evaluate(async ([id, text]) => {
    await new Promise<void>((resolve) => {
      const port = chrome.runtime.connect({ name: 'webknow' });
      port.onMessage.addListener((event) => { if (event.type === 'reply') { port.disconnect(); resolve(); } });
      port.postMessage({ id: 71, command: { type: 'setQuote', tabId: id, text } });
    });
  }, [tabId, text] as const);
  await select('样本只有三个经过培训的团队');
  await expect(panel.locator('.composer .quote-chip')).toContainText('三个经过培训');
  await input.fill('如何理解这个范围？');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.composer .quote-chip')).toBeHidden();
  await expect(panel.locator('.bubble.user')).toContainText('三个经过培训');
  await expect(input).toHaveValue('');
  await select('新方案的平均处理时间为八十分钟');
  await input.fill('下一次的草稿');
  release();
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeHidden();
  await expect(panel.locator('.composer .quote-chip')).toContainText('八十分钟');
  await expect(input).toHaveValue('下一次的草稿');
  await panel.close(); await article.close(); await context.unroute('https://api.deepseek.com/chat/completions');
});

test('停止第一问后继续提问，不虚构跳过记录', async () => {
  let calls = 0;
  let release = () => {};
  const pause = new Promise<void>((done) => { release = done; });
  await context.route('https://api.deepseek.com/chat/completions', async (route) => {
    const index = calls++;
    if (index === 1) await pause;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(index === 0
      ? { summary: '试点有明确数字。', bubbles: [] } : { action: 'question', question: '新方案用了多少分钟？' }) }).catch(() => {});
  });
  const { panel, article, tabId } = await openPanel();
  await panel.getByRole('tab', { name: 'AI 问', exact: true }).click();
  const stop = panel.getByRole('button', { name: '停止', exact: true });
  await expect(stop).toBeEnabled();
  await stop.click();
  release();
  await panel.getByRole('button', { name: '继续提问', exact: true }).click();
  await expect(panel.getByText('新方案用了多少分钟？', { exact: true })).toBeVisible();
  expect((await storedLearning(tabId)).learning.log.some((entry) => entry.role === 'skip')).toBe(false);
  await panel.close(); await article.close(); await context.unroute('https://api.deepseek.com/chat/completions');
});
