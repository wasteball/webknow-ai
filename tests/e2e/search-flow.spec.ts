import { expect, test } from '@playwright/test';
import { launchResearchFixture } from './helpers/research';

test('local search permission reaches the real router and completed research pipeline', async () => {
  const f = await launchResearchFixture({ enabled: false });
  try {
    await expect(f.panel.getByRole('button', { name: '联网搜索', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(f.panel.getByLabel('本题联网方式')).toHaveCount(0);
    await f.ask('Atlas 今天最新版本是什么？', true);
    await f.waitFinished();
    expect(f.hits).toHaveLength(1);
    expect(f.hits[0]).toContain('Atlas 当前版本');
    expect(f.hits[0]).not.toContain('Atlas 今天最新版本是什么');
    await expect(f.panel.getByText('根据网络资料，Atlas 当前版本为 3。', { exact: true }).first()).toBeVisible();
  } finally { await f.close(); }
});

test('local OFF prevents search for a latest question regardless of legacy global setting', async () => {
  for (const enabled of [true, false]) {
    const f = await launchResearchFixture({ enabled });
    try {
      await f.ask('Atlas 今天最新版本是什么？', false);
      await f.waitFinished();
      expect(f.hits).toHaveLength(0);
      await expect(f.panel.getByRole('button', { name: '联网搜索', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await expect(f.panel.getByText(/未联网核验/).first()).toBeVisible();
      await expect(f.panel.getByText(/联网总开关已关闭/)).toHaveCount(0);
    } finally { await f.close(); }
  }
});

test('search settings retain tool configuration without research controls', async () => {
  const f = await launchResearchFixture();
  try {
    await expect(f.panel.getByRole('button', { name: '联网搜索', exact: true })).toBeVisible();
    const settings = await f.context.newPage();
    await settings.goto(`chrome-extension://${f.extensionId}/options.html`);
    await settings.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '联网搜索' }).click();
    const radios = settings.getByRole('radiogroup', { name: '搜索服务' }).getByRole('radio');
    await expect(radios.nth(1)).toContainText(/Firecrawl/);
    await expect(radios.nth(1)).toContainText(/免费/);
    await expect(radios.nth(2)).toContainText(/Bing/);
    await expect(radios.nth(3)).toContainText(/DuckDuckGo/);
    await expect(radios.nth(4)).toContainText(/SearXNG/);
    await radios.nth(1).click();
    await expect(settings.getByText(/不用注册也不用填任何东西/)).toBeVisible();
    await expect(settings.getByLabel('API Key', { exact: true })).toBeHidden();
    await expect(settings.getByLabel('实例地址')).toBeHidden();
    await expect(settings.getByRole('button', { name: '授权并启用' })).toBeEnabled();
    await settings.getByRole('radio', { name: /Tavily/ }).click();
    await expect(settings.getByLabel('API Key', { exact: true })).toBeVisible();
    await expect(settings.getByLabel('智能联网', { exact: true })).toHaveCount(0);
    await expect(settings.getByLabel('联网 Agent 策略', { exact: true })).toHaveCount(0);
    await expect(settings.getByRole('button', { name: '保存联网策略', exact: true })).toHaveCount(0);
    await expect(settings.getByRole('combobox')).toHaveCount(0);
  } finally { await f.close(); }
});

test('turning local search OFF aborts its current transport and preserves the next draft', async () => {
  const f = await launchResearchFixture();
  try {
    await f.hold('searching');
    await f.ask('Atlas 今天最新版本是什么？', true);
    await f.waitPhase('searching');
    await f.panel.getByLabel('向这篇文章提问').fill('下一题草稿');
    await f.setSearch(false);
    await f.stopped();
    await expect.poll(() => f.worker.evaluate(() => (globalThis as any).__research.aborted)).toBe(1);
    const after = (await f.records()).length;
    await f.release();
    expect((await f.session()).chat).toHaveLength(0);
    expect((await f.records()).length).toBe(after);
    await expect(f.panel.getByLabel('向这篇文章提问')).toHaveValue('下一题草稿');
  } finally { await f.close(); }
});
