// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: { permissions: { request: vi.fn(async () => true) } } }));
import { Setup } from '../src/sidepanel/components/Setup';
import { SearchSettings } from '../src/sidepanel/components/SearchSettings';
import { panel } from './helpers/panel';
afterEach(cleanup);
it('edits active policy, retains drafts through refresh, and restores only this policy', async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  const { rerender } = render(<SearchSettings state={panel()} send={send} />);
  const box = screen.getByLabelText('联网 Agent 策略') as HTMLTextAreaElement;
  expect(box.value).toContain('每次重试必须改变检索策略');
  fireEvent.change(box, { target: { value: '优先官方来源，简洁回答。' } });
  rerender(<SearchSettings state={panel()} send={send} />);
  expect(box.value).toBe('优先官方来源，简洁回答。');
  fireEvent.click(screen.getByRole('button', { name: '保存联网策略' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'saveSearchAgentSettings', patch: { policy: '优先官方来源，简洁回答。' } }));
  fireEvent.click(screen.getByRole('button', { name: '恢复默认联网策略' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'saveSearchAgentSettings', patch: { policy: '' } }));
});
it('keeps six providers, masks keys, requests permissions in the gesture then tests', async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  render(<SearchSettings state={panel()} send={send} />);
  expect((screen.getByRole('checkbox', { name: '智能联网' }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getAllByRole('radio')).toHaveLength(7);
  fireEvent.click(screen.getByRole('radio', { name: /Tavily/ }));
  const input = screen.getByLabelText('API Key') as HTMLInputElement;
  expect(input.type).toBe('password'); expect(input.value).toBe('');
  fireEvent.change(input, { target: { value: 'own-key' } });
  fireEvent.click(screen.getByRole('button', { name: '授权并启用' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'testSearch', providerId: 'tavily' }));
  expect(input.value).toBe('');
  expect((screen.getByRole('option', { name: /直接读取/ }) as HTMLOptionElement).disabled).toBe(true);
});

it('shows shared receiver boundaries before initial key setup', () => {
  const state = panel(); state.settings.provider = 'zhipu';
  state.settings.search.providerName = 'Firecrawl'; state.settings.search.sourceCapabilities.providerContent = true;
  render(<Setup settings={state.settings} onOpenSettings={vi.fn()} />);
  expect(screen.getByText(/智谱（Zhipu） 接收当前文章正文/)).toBeTruthy();
  expect(screen.getByText(/内容接口（Firecrawl）接收所选来源 URL/)).toBeTruthy();
  expect(screen.getByText(/自己的认证通道/)).toBeTruthy();
});
