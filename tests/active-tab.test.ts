import { beforeEach, describe, expect, it, vi } from 'vitest';

const tabs = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn() }));
const getViews = vi.hoisted(() => vi.fn());
vi.mock('wxt/browser', () => ({
  browser: { tabs, extension: { getViews }, runtime: { getURL: (path: string) => `chrome-extension://webknow${path}` } },
}));

import { activeTabId } from '../src/sidepanel/api';

beforeEach(() => {
  vi.resetAllMocks();
  tabs.get.mockResolvedValue({ id: 7, windowId: 1 });
  getViews.mockReturnValue([]);
});

describe('设置页保留来源文章', () => {
  it('没有 tabs 权限看不到 URL 时，从自家扩展视图识别设置页', async () => {
    tabs.query.mockResolvedValue([{ id: 9, windowId: 1 }]);
    getViews.mockReturnValue([{ location: { href: 'chrome-extension://webknow/options.html?tab=7#search' } }]);
    expect(await activeTabId()).toBe(7);
  });

  it.each(['url', 'pendingUrl'])('设置页的 %s 指向原文章时，侧栏继续附着原文章', async (field) => {
    tabs.query.mockResolvedValue([{ id: 9, windowId: 1, [field]: 'chrome-extension://webknow/options.html?tab=7#search' }]);
    expect(await activeTabId()).toBe(7);
  });

  it.each([
    'https://example.com/options.html?tab=7',
    'chrome-extension://another/options.html?tab=7',
    'chrome-extension://webknow/options.html?tab=7invalid',
    'chrome-extension://webknow/options.html',
  ])('其它页面或无效来源不改变当前标签：%s', async (url) => {
    tabs.query.mockResolvedValue([{ id: 9, windowId: 1, url }]);
    expect(await activeTabId()).toBe(9);
  });

  it('原文章已关闭或属于另一窗口时，不继续附着', async () => {
    tabs.query.mockResolvedValue([{ id: 9, windowId: 1, url: 'chrome-extension://webknow/options.html?tab=7' }]);
    tabs.get.mockRejectedValueOnce(new Error('No tab'));
    expect(await activeTabId()).toBe(9);
    tabs.get.mockResolvedValueOnce({ id: 7, windowId: 2 });
    expect(await activeTabId()).toBe(9);
  });
});
