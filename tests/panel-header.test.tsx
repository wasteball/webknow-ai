// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      connect: vi.fn(() => ({
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      })),
      getURL: (path: string) => `chrome-extension://test${path}`,
    },
    permissions: { request: vi.fn(async () => false) },
  },
}));

import { App } from '../src/sidepanel/App';

describe('侧栏顶栏', () => {
  it('只有一行：光点 + 更多；设置、清空、帮助都在更多里，设置在侧栏内打开', () => {
    render(<App />);
    expect(screen.queryByRole('heading', { name: '知伴' })).toBeNull();
    const header = document.querySelector('.panel-header');
    expect(header?.contains(screen.getByRole('img', { name: 'WebKnow AI' }))).toBe(true);
    const more = screen.getByRole('button', { name: '更多' });
    expect(header?.contains(more)).toBe(true);
    expect(screen.queryByRole('menuitem', { name: '设置' })).toBeNull();
    fireEvent.click(more);
    expect(screen.getByRole('menuitem', { name: '设置' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '清空这一页的对话' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '使用帮助' })).toBeTruthy();
  });
});
