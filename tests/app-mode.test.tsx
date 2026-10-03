// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { panel } from './helpers/panel';
import type { Event, PortRequest } from '../src/core/protocol';

const transport = vi.hoisted(() => {
  const listeners: ((event: unknown) => void)[] = [];
  const commands: PortRequest['command'][] = [];
  return { listeners, commands };
});
vi.mock('wxt/browser', () => ({ browser: {
  tabs: { query: vi.fn(async () => [{ id: 7 }]),
    onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
  runtime: { connect: () => ({
    onMessage: { addListener: (fn: (event: unknown) => void) => transport.listeners.push(fn) },
    onDisconnect: { addListener: vi.fn() }, disconnect: vi.fn(),
    postMessage: (request: PortRequest) => {
      transport.commands.push(request.command);
      queueMicrotask(() => transport.listeners.forEach((fn) => fn({ type: 'reply', id: request.id, reply: { ok: true } })));
    },
  }) },
} }));
import { App } from '../src/sidepanel/App';

beforeEach(() => { transport.listeners.length = 0; transport.commands.length = 0; });

it('keeps the local search switch through real mode changes and resets it on a new article key', async () => {
  render(<App />);
  await act(async () => {});
  const state = panel({ sessionId: 'article-a' });
  state.settings.search = { ...state.settings.search, enabled: true, providerName: 'Firecrawl' };
  const emit = async (next: typeof state) => act(async () => transport.listeners.forEach(fn => fn({ type: 'state', state: next })));
  await emit(state);
  const chip = screen.getByRole('button', { name: '联网搜索' });
  expect(chip.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(chip);
  fireEvent.click(screen.getByRole('tab', { name: 'AI 问' }));
  await act(async () => {});
  fireEvent.click(screen.getByRole('tab', { name: '问 AI' }));
  expect(screen.getByRole('button', { name: '联网搜索' }).getAttribute('aria-pressed')).toBe('true');
  await emit({ ...state, sessionId: 'article-b', pageUrl: 'https://example.com/next' });
  expect(screen.getByRole('button', { name: '联网搜索' }).getAttribute('aria-pressed')).toBe('false');
});

it('同一篇文章的后台学习状态更新不会强制切模式', async () => {
  render(<App />);
  await act(async () => {});
  const state = panel({ sessionId: 'same-article' });
  await act(async () => transport.listeners.forEach((fn) => fn({ type: 'state', state })));
  expect(screen.getByRole('tab', { name: '问 AI' }).getAttribute('aria-selected')).toBe('true');
  await act(async () => transport.listeners.forEach((fn) => fn({ type: 'state', state: { ...state,
    phase: 'LEARNING', sessionState: 'LEARNING', learning: { goal: '核心', promptVersion: '1', used: 0, status: 'active', current: null, log: [] } } })));
  expect(screen.getByRole('tab', { name: '问 AI' }).getAttribute('aria-selected')).toBe('true');
});

it('新文章不沿用上一页的 AI 问选择，只有主动进入才能发起首问', async () => {
  render(<App />);
  await act(async () => {});
  const emit = async (state: ReturnType<typeof panel>) => act(async () => {
    const event: Event = { type: 'state', state };
    transport.listeners.forEach((fn) => fn(event));
  });
  await emit(panel({ sessionId: 'article-a' }));
  fireEvent.click(screen.getByRole('tab', { name: 'AI 问' }));
  await act(async () => {});
  expect(transport.commands.filter((command) => command.type === 'learnStart')).toHaveLength(1);
  await emit(panel({ sessionId: 'article-b', pageTitle: '第二篇文章' }));
  expect(transport.commands.filter((command) => command.type === 'learnStart')).toHaveLength(1);
  expect(screen.getByRole('tab', { name: '问 AI' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: 'AI 问' }));
  await act(async () => {});
  expect(transport.commands.filter((command) => command.type === 'learnStart')).toHaveLength(2);
});
