import { expect, test } from '@playwright/test';
import { launchResearchFixture } from './helpers/research';

// Regression for router dropping per-question search mode: run a valid research action
// and both audits to completion, then inspect the actual worker transport requests.
test('per-question force reaches the real router and completed research pipeline', async () => {
  const f = await launchResearchFixture();
  try {
    await f.ask('Atlas 的版本是什么？', 'force');
    await f.waitFinished();
    expect(f.hits).toHaveLength(1);
    expect(f.hits[0]).toContain('Atlas 当前版本');
    expect(f.hits[0]).not.toContain('Atlas 的版本是什么');
    await expect(f.panel.getByText('根据网络资料，Atlas 当前版本为 3。', { exact: true }).first()).toBeVisible();
  } finally { await f.close(); }
});

test('article override and global OFF prevent search even for a latest question', async () => {
  for (const enabled of [true, false]) {
    const f = await launchResearchFixture({ enabled });
    try {
      await f.ask('Atlas 今天最新版本是什么？', enabled ? 'article' : 'force');
      await f.waitFinished();
      expect(f.hits).toHaveLength(0);
      await expect(f.panel.getByLabel('本题联网方式')).toHaveValue(enabled ? 'article' : 'force');
      await expect(f.panel.getByText(/未联网核验/).first()).toBeVisible();
      if (!enabled) await expect(f.panel.getByText(/联网总开关已关闭/)).toBeVisible();
    } finally { await f.close(); }
  }
});

test('search settings keep keyless order, global switch and per-question mode reachable', async () => {
  const f = await launchResearchFixture();
  try {
    await expect(f.panel.getByLabel('本题联网方式')).toBeVisible();
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
    await expect(settings.getByLabel('智能联网', { exact: true })).toBeChecked();
    await settings.getByLabel('智能联网', { exact: true }).click();
    await expect(settings.getByLabel('智能联网', { exact: true })).not.toBeChecked();
  } finally { await f.close(); }
});
