import { expect, test } from '@playwright/test';
import { launchResearchFixture } from './helpers/research';

test('article explanation finishes before asserting zero searches', async () => {
  const f = await launchResearchFixture();
  try {
    await f.ask('解释这篇文章中的试点方法', 'auto');
    await f.waitFinished();
    expect(f.hits).toHaveLength(0);
    await expect(f.panel.locator('#mode-panel-qa .msg.ai .said:not(.said-guide)')).toContainText('三个团队');
  } finally { await f.close(); }
});

test('latest research uses frozen dates, safe source IDs and separate receiver payloads', async () => {
  const f = await launchResearchFixture();
  try {
    await f.ask('Atlas 今天最新版本是什么？', 'auto'); await f.waitFinished();
    expect(f.hits).toHaveLength(1);
    const records = await f.records();
    const search = records.find(r => r.url.endsWith('/v1/web-search'))!;
    expect(JSON.parse(search.body)).toEqual({ query: expect.stringContaining('Atlas 当前版本'), summary: true, count: 5 });
    expect(search.body).not.toMatch(/三个团队|四周|history|sk-synthetic-model/);
    expect(search.headers.authorization).toBe('Bearer sk-synthetic-search-only');
    const models = records.filter(r => r.url.includes('/chat/completions'));
    expect(models.every(r => r.url === 'https://api.deepseek.com/chat/completions')).toBe(true);
    expect(models.every(r => !r.body.includes('sk-synthetic'))).toBe(true);
    const payloads = models.slice(1).map(r => {
      const content = JSON.parse(r.body).messages.at(-1).content as string;
      return JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
    });
    const action = payloads.find(p => p.gate)!;
    const evidence = payloads.find(p => p.sources)!;
    expect(evidence.time).toEqual(action.gate.time);
    expect(evidence.sources[0].publishedAt).toBe(action.gate.time.localDate);
    expect(evidence.sources[0].sourceId).toMatch(/^sr_[a-zA-Z0-9_-]+_1$/);
    expect(evidence.sources[0].url).toBe('https://example.org/atlas/release');
    const summary = f.panel.locator('#mode-panel-qa .research-details summary');
    await summary.focus(); await f.panel.keyboard.press('Enter');
    await expect(f.panel.locator('#mode-panel-qa .research-details')).toHaveAttribute('open', '');
    await expect(f.panel.getByRole('link', { name: 'Atlas 官方版本公告' })).toHaveAttribute('rel', 'noreferrer');
    await expect(f.panel.getByText(/未读正文，仅搜索摘要/)).toBeVisible();
  } finally { await f.close(); }
});

for (const scenario of ['latest', 'ambiguous'] as const) {
  test(`live query and pending/adopted source details update before finish (${scenario})`, async () => {
    const f = await launchResearchFixture({ scenario });
    try {
      await f.hold('checking');
      await f.ask(scenario === 'ambiguous' ? '今天最新版本是什么？' : 'Atlas 今天最新版本是什么？', 'force');
      if (scenario === 'ambiguous') {
        await expect(f.panel.getByRole('region', { name: '研究澄清' })).toBeVisible();
        await f.panel.getByLabel('补充条件').fill('Atlas 数据库');
        await f.panel.getByRole('button', { name: '继续', exact: true }).click();
      }
      await f.waitPhase('checking');
      const details = f.panel.locator('#mode-panel-qa .research-details');
      await details.locator('summary').click();
      await expect(details).toContainText('Atlas 当前版本');
      await expect(details).toContainText('待核验');
      await expect(details.getByRole('link', { name: 'Atlas 官方版本公告' })).toBeVisible();
      expect((await f.session()).chat).toHaveLength(0);
      await f.hold('answering'); await f.release(); await f.waitPhase('answering');
      await expect(details).toContainText('没有未采用来源');
      await expect(details).not.toContainText('暂无已采用来源');
      expect((await f.session()).chat).toHaveLength(0);
      await f.release(); await f.waitFinished();
    } finally { await f.close(); }
  });
}

test('live source read result updates while the second assessment is still pending', async () => {
  const f = await launchResearchFixture({ scenario: 'content-failure' });
  try {
    await f.hold('reading'); await f.ask('Atlas 今天最新版本是什么？', 'force'); await f.waitPhase('reading');
    const details = f.panel.locator('#mode-panel-qa .research-details');
    await details.locator('summary').click();
    await expect(details).toContainText('Atlas 当前版本');
    await expect(details).not.toContainText('暂无已采用来源');
    await expect(details).toContainText('未读正文，仅搜索摘要');
    await f.hold('checking'); await f.release(); await f.waitPhase('checking');
    await expect(details).toContainText('正文不可读取，仅搜索摘要');
    expect((await f.session()).chat).toHaveLength(0);
    await f.release(); await f.waitFinished();
  } finally { await f.close(); }
});

test('retry changes the actual query and adds evidence before answering', async () => {
  const f = await launchResearchFixture({ scenario: 'retry' });
  try {
    await f.ask('Atlas 今天最新版本是什么？', 'force'); await f.waitFinished();
    expect(f.hits).toHaveLength(2);
    expect(f.hits.map(h => JSON.parse(h).query)).toEqual([
      expect.stringContaining('Atlas 当前版本'), expect.stringContaining('Atlas 官方发布版本公告'),
    ]);
    expect(f.hits[0]).not.toBe(f.hits[1]);
    await f.panel.locator('#mode-panel-qa .research-details summary').click();
    await expect(f.panel.getByText('第 1 次 · 找到 0 个来源', { exact: false })).toBeVisible();
    await expect(f.panel.getByText('第 2 次 · 找到 1 个来源', { exact: false })).toBeVisible();
  } finally { await f.close(); }
});

test('SearXNG latest research adopts unknown dates without claiming time verification', async () => {
  const f = await launchResearchFixture({ scenario: 'searxng-date-unknown' });
  try {
    await f.ask('Atlas 今天最新版本是什么？', 'force'); await f.waitFinished();
    const records = await f.records();
    const searches = records.filter(r => r.url.includes('/search') || r.url.endsWith('/v1/web-search'));
    expect(searches).toHaveLength(1);
    const url = new URL(searches[0]!.url);
    expect(url.origin).toBe(new URL(f.article.url()).origin);
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toMatch(/^Atlas 当前版本 after:\d{4}-\d{2}-\d{2} before:\d{4}-\d{2}-\d{2}$/);
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.has('time_range')).toBe(false);
    expect(searches[0]).toMatchObject({ method: 'GET', body: '' });
    expect(searches[0]!.headers).not.toHaveProperty('authorization');
    expect(searches[0]!.url).not.toMatch(/三个团队|四周|history|sk-synthetic/);
    const modelContexts = records.filter(r => r.url.includes('/chat/completions')).slice(1).map(r => {
      const content = JSON.parse(r.body).messages.at(-1).content as string;
      return JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
    });
    expect(modelContexts.find(p => p.sources)?.sources[0]).toMatchObject({ provider: 'searxng', publishedAt: null, dateStatus: 'date_unknown' });
    expect(modelContexts.find(p => p.candidate)?.candidate.freshness).toBe('date_unknown');
    const complete = (await f.session()).chat[0];
    expect(complete?.research).toMatchObject({ freshness: 'date_unknown', degraded: true, sources: [
      { provider: 'searxng', publishedAt: null, dateStatus: 'date_unknown', decision: 'accepted' },
    ] });
    expect(complete?.webReferences).toMatchObject([{ publishedAt: null, url: 'https://example.org/atlas/release' }]);
    await expect(f.panel.locator('#mode-panel-qa .msg.ai .said:not(.said-guide)').last()).toContainText('日期未知，无法确认最新版本');
    await f.panel.locator('#mode-panel-qa .research-details summary').click();
    await expect(f.panel.getByText(/发布时间未知，未完成时间核验/)).toBeVisible();
    await expect(f.panel.getByText(/发布时间：日期未知/)).toBeVisible();
    expect(f.unexpected).toEqual([]);
  } finally { await f.close(); }
});

test('provider content failure only reads selected source and returns to honest summary', async () => {
  const f = await launchResearchFixture({ scenario: 'content-failure' });
  try {
    await f.ask('Atlas 今天最新版本是什么？', 'force'); await f.waitFinished();
    const sources = (await f.session()).chat[0]?.research?.sources;
    expect(sources?.map(s => s.url)).toEqual(['https://example.org/atlas/release', 'https://example.net/atlas/mirror']);
    expect(sources?.map(s => s.readStatus)).toEqual(['unavailable', 'not_read']);
    const reads = (await f.records()).filter(r => r.url.endsWith('/v2/scrape'));
    expect(reads).toHaveLength(1);
    expect(JSON.parse(reads[0]!.body)).toEqual({ url: 'https://example.org/atlas/release', formats: ['markdown'] });
    expect(reads[0]).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(reads[0]!.headers).not.toHaveProperty('authorization');
    expect(reads[0]!.headers).not.toHaveProperty('cookie');
    expect((await f.records()).some(r => r.url === 'https://example.org/atlas/release')).toBe(false);
    expect((await f.records()).some(r => r.url === 'https://example.net/atlas/mirror')).toBe(false);
    await f.panel.locator('#mode-panel-qa .research-details summary').click();
    await expect(f.panel.getByText(/正文不可读取，仅搜索摘要/)).toBeVisible();
    await expect(f.panel.getByText(/日期未知，无法确认最新版本/).first()).toBeVisible();
  } finally { await f.close(); }
});

for (const scenario of ['stale', 'conflict', 'empty', 'injection'] as const) {
  test(`${scenario} evidence preserves disclosure and never invents latest facts`, async () => {
    const f = await launchResearchFixture({ scenario });
    try {
      await f.ask('Atlas 今天最新版本是什么？', 'auto'); await f.waitFinished();
      const answer = f.panel.locator('#mode-panel-qa .msg.ai .said:not(.said-guide)').last();
      await expect(answer).toContainText(scenario === 'stale' ? '资料较旧' : scenario === 'conflict' ? '版本冲突' : scenario === 'empty' ? '未找到资料' : '这次没有核验成功');
      await expect(answer).not.toContainText('Atlas 当前版本为 3。');
      expect((await f.records()).every(r => !r.url.includes('untrusted-page-command'))).toBe(true);
      if (scenario === 'injection') expect(f.hits).toHaveLength(0);
    } finally { await f.close(); }
  });
}

test('clarification resumes the same frozen run with intent visible to both auditors', async () => {
  const f = await launchResearchFixture({ scenario: 'ambiguous' });
  try {
    await f.ask('今天最新版本是什么？', 'force');
    await expect(f.panel.getByRole('region', { name: '研究澄清' })).toBeVisible();
    const waiting = await f.session();
    const checkpoint = waiting.researchCheckpoint;
    if (!checkpoint) throw new Error('Waiting research checkpoint missing');
    const before = (await f.records()).length;
    await f.panel.getByLabel('补充条件').fill('Atlas 数据库');
    await f.panel.getByRole('button', { name: '继续', exact: true }).click();
    await f.waitFinished();
    const bodies = (await f.records()).slice(before).filter(r => r.url.includes('/chat/completions'));
    for (const r of bodies) expect(r.body).toContain('Atlas 数据库');
    const research = (await f.session()).chat[0]?.research;
    if (!research) throw new Error('Completed research metadata missing');
    expect(research.sources[0]?.sourceId).toBe(`sr_${checkpoint.snapshot.identity.runId}_1`);
    expect(research.sources[0]?.publishedAt).toBe(checkpoint.snapshot.gate.time.localDate);
  } finally { await f.close(); }
});

for (const phase of ['deciding', 'searching', 'reading', 'checking', 'answering'] as const) {
  test(`stop in ${phase} aborts transport, prevents next action and preserves draft`, async () => {
    const f = await launchResearchFixture({ scenario: phase === 'reading' ? 'content-failure' : 'latest', width: 320, height: 400, large: true });
    try {
      await f.panel.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await f.hold(phase); await f.ask('Atlas 今天最新版本是什么？', 'force'); await f.waitPhase(phase);
      const stop = f.panel.getByRole('button', { name: '停止', exact: true });
      const bounds = await stop.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(400);
      expect(await f.panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await f.panel.getByLabel('向这篇文章提问').fill('下一题草稿');
      await stop.focus(); await f.panel.keyboard.press('Enter'); await f.stopped();
      await expect(f.panel.getByRole('region', { name: '研究已停止' })).toBeVisible();
      const after = (await f.records()).length;
      await expect.poll(() => f.worker.evaluate(() => (globalThis as any).__research.aborted)).toBe(1);
      await f.release();
      await expect.poll(async () => (await f.records()).length).toBe(after);
      expect((await f.session()).chat).toHaveLength(0);
      await expect(f.panel.getByLabel('向这篇文章提问')).toHaveValue('下一题草稿');
    } finally { await f.close(); }
  });
}

test('waiting cancellation sends no request until explicit new-run action', async () => {
  const f = await launchResearchFixture({ scenario: 'ambiguous' });
  try {
    await f.ask('今天最新版本是什么？', 'force');
    await expect(f.panel.getByRole('region', { name: '研究澄清' })).toBeVisible();
    const before = (await f.records()).length;
    await f.panel.getByRole('button', { name: '取消', exact: true }).click();
    await expect(f.panel.getByRole('region', { name: '研究已停止' })).toBeVisible();
    expect((await f.records()).length).toBe(before);
    await expect(f.panel.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);
    await f.panel.getByRole('button', { name: '重新研究这个问题' }).click();
    await expect(f.panel.getByRole('region', { name: '研究澄清' })).toBeVisible();
    expect((await f.records()).length).toBe(before + 1);
  } finally { await f.close(); }
});

test('native source details preserve bottom and review scroll positions, then latest/new messages follow', async () => {
  const f = await launchResearchFixture({ width: 320, height: 440, large: true });

  try {
    await f.panel.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await f.ask('Atlas 今天最新版本是什么？', 'force'); await f.waitFinished();

    // Layout fixture retains an actually accepted research result and its safe metadata.
    const session = await f.session();
    const accepted = session.chat[0];
    if (!accepted?.research) throw new Error('Accepted research turn missing for layout fixture');
    session.chat = Array.from({ length: 8 }, (_, index) => ({ ...accepted, id: `layout-${index}`,
        question: `第 ${index + 1} 题`, answer: '根据网络资料，Atlas 当前版本为 3。'.repeat(20) }));
    await f.worker.evaluate(async ({ tabId, session }) => {
      await chrome.storage.session.set({ [`sess:${tabId}`]: session });
    }, { tabId: f.tabId, session });

    await f.panel.reload();
    const area = f.panel.locator('#mode-panel-qa .chat-scroll');
    const summaries = f.panel.locator('#mode-panel-qa .research-details summary');
    await expect(summaries).toHaveCount(8);
    const position = () => area.evaluate(n => n.scrollTop);
    const bottom = () => area.evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop);

    await summaries.last().focus();
    await area.evaluate(n => { n.scrollTop = n.scrollHeight; });
    await expect.poll(bottom).toBeLessThan(2);
    const before = await position();

    await f.panel.keyboard.press('Space');
    await expect(summaries.last().locator('..')).toHaveAttribute('open', '');
    await expect.poll(async () => Math.abs(await position() - before)).toBeLessThanOrEqual(1);
    await expect.poll(bottom).toBeGreaterThan(80);

    await f.panel.keyboard.press('Space');
    await expect(summaries.last().locator('..')).not.toHaveAttribute('open', '');
    await expect.poll(async () => Math.abs(await position() - before)).toBeLessThanOrEqual(1);
    // Establish actual user review state before keyboard activation. A focus scroll
    // alone can coalesce with toggle's position capture before onScroll is dispatched.
    await area.hover(); await f.panel.mouse.wheel(0, -700);
    await expect(f.panel.getByRole('button', { name: '回到最新消息' })).toBeVisible();

    await summaries.nth(2).focus();
    const reviewing = await position();
    expect(reviewing).toBeLessThan(before);
    await f.panel.keyboard.press('Enter');
    await expect(summaries.nth(2).locator('..')).toHaveAttribute('open', '');
    await expect.poll(async () => Math.abs(await position() - reviewing)).toBeLessThanOrEqual(1);
    await f.panel.keyboard.press('Enter');
    await expect(summaries.nth(2).locator('..')).not.toHaveAttribute('open', '');
    await expect.poll(async () => Math.abs(await position() - reviewing)).toBeLessThanOrEqual(1);

    await f.panel.getByRole('button', { name: '回到最新消息' }).click();
    await expect.poll(bottom).toBeLessThan(2);
    await f.ask('Atlas 今天最新版本是什么？', 'force'); await f.waitFinished();

    await expect(summaries).toHaveCount(9);
    await expect.poll(bottom).toBeLessThan(2);
    expect(f.unexpected).toEqual([]);
  } finally { await f.close(); }
});

test('immediate native keyboard summary activation preserves review through incoming updates', async () => {
  const f = await launchResearchFixture({ width: 320, height: 440, large: true });
  try {
    await f.panel.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await f.ask('Atlas 今天最新版本是什么？', 'force'); await f.waitFinished();
    const session = await f.session(); const accepted = session.chat[0]!;
    session.chat = Array.from({ length: 8 }, (_, index) => ({ ...accepted, id: `keyboard-${index}`, question: `第 ${index + 1} 题`,
      answer: '根据网络资料，Atlas 当前版本为 3。'.repeat(20) }));
    await f.worker.evaluate(async ({ tabId, session }) => chrome.storage.session.set({ [`sess:${tabId}`]: session }), { tabId: f.tabId, session });
    await f.panel.reload();
    const summaries = f.panel.locator('#mode-panel-qa .research-details summary');
    await expect(summaries).toHaveCount(8);
    const area = f.panel.locator('#mode-panel-qa .chat-scroll');
    const position = () => area.evaluate(n => n.scrollTop);
    const gap = () => area.evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop);
    await f.panel.getByLabel('向这篇文章提问').focus();
    await area.evaluate(n => { n.scrollTop = n.scrollHeight; });
    await expect.poll(gap).toBeLessThan(2);
    // Native traversal and immediate activation: no wheel, locator focus, or away-state wait.
    await f.panel.keyboard.press('Shift+Tab'); await f.panel.keyboard.press('Shift+Tab');
    await f.panel.keyboard.press('Enter');
    const focused = f.panel.locator('#mode-panel-qa .research-details > summary:focus');
    await expect(focused).toHaveCount(1);
    await expect(focused.locator('..')).toHaveAttribute('open', '');
    expect(await gap()).toBeGreaterThan(80);
    const latest = f.panel.getByRole('button', { name: '回到最新消息' });
    await expect(latest).toBeVisible();
    const reviewing = await position();
    // Deliver another accepted turn through a normal state broadcast, without a local send/follow request.
    session.chat.push({ ...accepted, id: 'incoming', question: '后到的消息' });
    await f.worker.evaluate(async ({ tabId, session }) => chrome.storage.session.set({ [`sess:${tabId}`]: session }), { tabId: f.tabId, session });
    await f.panel.evaluate(async tabId => new Promise<void>(resolve => {
      const port = chrome.runtime.connect({ name: 'webknow' });
      port.onMessage.addListener(message => { if (message.type === 'reply') { port.disconnect(); resolve(); } });
      port.postMessage({ id: 91, command: { type: 'attach', tabId } });
    }), f.tabId);
    await expect(summaries).toHaveCount(9);
    await expect(latest).toContainText('有新消息');
    await expect.poll(async () => Math.abs(await position() - reviewing)).toBeLessThanOrEqual(1);
    await latest.focus(); await f.panel.keyboard.press('Enter');
    await expect.poll(gap).toBeLessThan(2);
    await expect(latest).toBeHidden();
  } finally { await f.close(); }
});

for (const change of ['navigation', 'body edit', 'model switch'] as const) {
  test(`${change} invalidates held research and rejects late answers`, async () => {
    const f = await launchResearchFixture();
    try {
      await f.hold('checking'); await f.ask('Atlas 今天最新版本是什么？', 'force'); await f.waitPhase('checking');
      if (change === 'navigation') await f.article.goto(`${new URL(f.article.url()).origin}/other.html`);
      if (change === 'body edit') await f.article.locator('article p').first().evaluate(n => { n.textContent = '正文已经改稿；旧研究必须失效。'; });
      if (change === 'model switch') {
        const settings = await f.context.newPage(); await settings.goto(`chrome-extension://${f.extensionId}/options.html`);
        await settings.evaluate(async () => new Promise<void>(resolve => {
          const port = chrome.runtime.connect({ name: 'webknow' });
          port.onMessage.addListener(msg => { if (msg.type === 'reply' && msg.id === 71) { port.disconnect(); resolve(); } });
          port.postMessage({ id: 71, command: { type: 'saveSettings', patch: { provider: 'zhipu' } } });
        }));
      }
      // Navigation/edit invalidates either eagerly or at the next physical/writeback boundary.
      await f.release();
      await f.stopped();
      await expect.poll(async () => (await f.session()).run).toBeNull();
      expect((await f.session()).chat).toHaveLength(0);
      expect(f.unexpected).toEqual([]);
    } finally { await f.close(); }
  });
}

test('panel reconnect and worker restart interrupt without automatically resending', async () => {
  const f = await launchResearchFixture({ scenario: 'ambiguous' });
  try {
    await f.ask('今天最新版本是什么？', 'force');
    await expect(f.panel.getByRole('region', { name: '研究澄清' })).toBeVisible();
    const before = (await f.records()).length;
    const original = (await f.session()).researchPending?.runId;
    if (!original) throw new Error('Waiting run ID missing');
    await f.panel.reload();
    await expect(f.panel.getByRole('region', { name: '研究已停止' })).toBeVisible();
    await expect(f.panel.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);
    expect((await f.records()).length).toBe(before);
    expect((await f.session()).researchCheckpoint ?? null).toBeNull();
    await f.panel.getByRole('button', { name: '重新研究这个问题' }).click();
    await expect(f.panel.getByRole('region', { name: '研究澄清' })).toBeVisible();
    const restarted = (await f.session()).researchPending?.runId;
    if (!restarted) throw new Error('Restarted run ID missing');
    expect(restarted).not.toBe(original);
    expect((await f.records()).length).toBe(before + 1);
    const debugging = await f.context.newCDPSession(f.panel);
    let versionId: string | undefined;
    debugging.on('ServiceWorker.workerVersionUpdated', (event: { versions: { versionId: string; scriptURL: string }[] }) => {
      versionId = event.versions.find(v => v.scriptURL.includes(f.extensionId))?.versionId ?? versionId;
    });
    await debugging.send('ServiceWorker.enable'); await expect.poll(() => versionId).toBeTruthy();
    if (!versionId) throw new Error('Extension worker version missing after poll');
    await debugging.send('ServiceWorker.stopWorker', { versionId });
    await expect(f.panel.getByRole('region', { name: '研究已停止' })).toBeVisible({ timeout: 15_000 });
    await expect(f.panel.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);
    await expect(f.panel.getByRole('button', { name: '重新研究这个问题' })).toBeVisible();
    expect(f.unexpected).toEqual([]);
  } finally { await f.close(); }
});

test('editing/restoring research policy and clearing sessions leave credentials independent', async () => {
  const f = await launchResearchFixture();
  try {
    await f.ask('Atlas 今天最新版本是什么？', 'force'); await f.waitFinished();
    const initial = await f.config();
    expect(initial.apiKeys?.deepseek).toBe('sk-synthetic-model-only');
    expect(initial.search?.credentials?.bocha?.apiKey).toBe('sk-synthetic-search-only');
    const settings = await f.context.newPage();
    await settings.goto(`chrome-extension://${f.extensionId}/options.html?tab=${f.tabId}#search`);
    const policy = settings.getByLabel('联网 Agent 策略', { exact: true });
    await expect(policy).toBeVisible();
    const builtIn = await policy.inputValue();
    await policy.fill('只查原始发布者，日期未知时明确说明。');
    await settings.getByRole('button', { name: '保存联网策略', exact: true }).click();
    const config = f.config;
    await expect.poll(async () => (await config()).search?.agent?.policy).toBe('只查原始发布者，日期未知时明确说明。');
    expect((await config()).apiKeys).toEqual(initial.apiKeys);
    expect((await config()).search?.credentials).toEqual(initial.search?.credentials);
    expect((await f.session()).chat).toHaveLength(1);
    await settings.getByRole('button', { name: '恢复默认联网策略', exact: true }).click();
    await expect(policy).toHaveValue(builtIn);
    await expect.poll(async () => (await config()).search?.agent?.policy ?? '').toBe('');
    await settings.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '清除', exact: true }).click();
    await settings.getByRole('button', { name: '全部清掉', exact: true }).click();
    await expect.poll(() => f.worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter(k => k.startsWith('sess:')))).toEqual([]);
    expect((await config()).apiKeys).toEqual(initial.apiKeys);
    expect((await config()).search?.credentials).toEqual(initial.search?.credentials);
    expect((await config()).search?.agent?.enabled).toBe(true);
    expect((await config()).search?.agent?.policy ?? '').toBe('');
    expect(f.unexpected).toEqual([]);
  } finally { await f.close(); }
});
