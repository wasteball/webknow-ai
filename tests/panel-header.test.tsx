// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
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
  it('不再额外占一条应用顶栏，设置跟上下文操作放在同一行', () => {
    render(<App />);

    expect(screen.queryByRole('heading', { name: '知伴' })).toBeNull();
    expect(screen.queryByText('陪你读这一页')).toBeNull();

    const settings = screen.getByRole('button', { name: '设置' });
    const header = document.querySelector('.context-actions');
    expect(header?.contains(settings)).toBe(true);
    expect(document.querySelector('.panel-header')).toBeNull();
  });
});
