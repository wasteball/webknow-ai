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
  it('logo 与设置同排，不显示中文产品名或副标题', () => {
    render(<App />);
    expect(screen.queryByRole('heading', { name: '知伴' })).toBeNull();
    expect(screen.queryByText('陪你读这一页')).toBeNull();
    const header = document.querySelector('.panel-header');
    expect(header?.contains(screen.getByRole('button', { name: '设置' }))).toBe(true);
    expect(header?.contains(screen.getByRole('img', { name: 'WebKnow AI' }))).toBe(true);
    expect(screen.getAllByRole('button', { name: '设置' })).toHaveLength(1);
  });
});
