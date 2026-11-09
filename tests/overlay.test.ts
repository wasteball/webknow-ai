import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: {} }));

import { overlayCapable } from '../src/background/overlay';
import { overlayTabId } from '../src/sidepanel/api';

describe('页内浮层', () => {
  it.each([
    ['https://mp.weixin.qq.com/s/abc', true],
    ['http://127.0.0.1:3000/article.html', true],
    ['chrome://extensions', false],
    ['chrome-extension://abc/options.html', false],
    ['https://chromewebstore.google.com/detail/x', false],
    ['https://chrome.google.com/webstore/detail/x', false],
    ['https://example.com/paper.pdf', false],
    ['file:///C:/a.html', false],
    [undefined, false],
  ] as const)('%s 能否放浮层：%s（放不进就用 Chrome 侧栏）', (url, expected) => {
    expect(overlayCapable(url)).toBe(expected);
  });

  it('面板在浮层里固定绑定 URL 上的标签页；不在浮层里时返回 null', () => {
    expect(overlayTabId('chrome-extension://id/sidepanel.html?host=overlay&tab=42')).toBe(42);
    expect(overlayTabId('chrome-extension://id/sidepanel.html')).toBeNull();
    expect(overlayTabId('chrome-extension://id/sidepanel.html?host=overlay&tab=abc')).toBeNull();
    expect(overlayTabId('chrome-extension://id/sidepanel.html?tab=42')).toBeNull();
  });
});
