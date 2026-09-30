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
  await worker.evaluate(async () => chrome.storage.local.set({ config: { apiKeys: { deepseek: 'sk-test-not-real' },
    outbound: { version: '2026-09-19.2', acceptedAt: Date.now(), receiver: 'DeepSeek（深度求索）' } } }));
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((done) => server.close(() => done())); });

async function openPanel() {
  const panel = await context.newPage(); await panel.setViewportSize({ width: 360, height: 450 });
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
      { id: 'q1', text: '处理时间从多少降到多少？', choices: [{ id: 'A', label: '从一百分钟降到八十分钟' }, { id: 'B', label: '从八十分钟增加到一百分钟' }], answer: ['A'], why: '原文给出八十与一百。' },
      { id: 'q2', text: '原文有哪些适用限制？', choices: [{ id: 'A', label: longChoice }, { id: 'B', label: '所有城市都适用。' }], answer: ['A'], why: '仅三个团队。' },
    ] },
    { action: 'graded', analysis: '两个要点都找对了。', notes: [], nextQuiz: null, nextQuestion: '为什么不能直接推广到其他城市？' },
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
  await panel.getByLabel('自己写一个方向').fill('理解数字与适用范围');
  await panel.getByRole('button', { name: '开始', exact: true }).click();
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await panel.getByRole('tab', { name: '问 AI', exact: true }).click();
  const qa = panel.getByLabel('向这篇文章提问'); await qa.fill('准备下一次提问');
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  release();
  await expect.poll(async () => (await storedLearning(tabId)).learning.current !== null).toBe(true);
  await expect(panel.getByRole('tab', { name: '问 AI', exact: true })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('tab', { name: 'AI 问', exact: true }).click();
  await expect(panel.getByRole('group', { name: '1. 处理时间从多少降到多少？', exact: true })).toHaveCount(1);
  expect(await panel.locator('#mode-panel-learn .dock fieldset').count()).toBe(0);
  const submit = panel.getByRole('button', { name: '提交', exact: true }); await expect(submit).toBeDisabled();
  await panel.getByRole('radio', { name: '从一百分钟降到八十分钟', exact: true }).check();
  await panel.getByRole('radio', { name: longChoice, exact: true }).check();
  await expect(submit).toBeEnabled();
  const box = await submit.boundingBox(); expect(box!.y + box!.height).toBeLessThanOrEqual(451);
  await submit.click();
  await expect(panel.getByText('本轮 2/2 题正确。', { exact: false })).toBeVisible();
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
  await panel.getByRole('button', { name: '这篇文章的核心内容', exact: true }).click();
  const stop = panel.getByRole('button', { name: '停止', exact: true });
  await expect(stop).toBeEnabled();
  await stop.click();
  release();
  await panel.getByRole('button', { name: '继续提问', exact: true }).click();
  await expect(panel.getByText('新方案用了多少分钟？', { exact: true })).toBeVisible();
  expect((await storedLearning(tabId)).learning.log.some((entry) => entry.role === 'skip')).toBe(false);
  await panel.close(); await article.close(); await context.unroute('https://api.deepseek.com/chat/completions');
});
