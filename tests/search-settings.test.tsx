// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const permissionRequest = vi.hoisted(() => vi.fn<(_input: { origins?: string[] }) => Promise<boolean>>(async () => true));
vi.mock('wxt/browser', () => ({ browser: { permissions: { request: permissionRequest } } }));
import { browser } from 'wxt/browser';
import type { Command } from '../src/core/protocol';
import { Setup } from '../src/sidepanel/components/Setup';
import { SearchSettings } from '../src/sidepanel/components/SearchSettings';
import { panel } from './helpers/panel';
beforeEach(() => { permissionRequest.mockReset().mockResolvedValue(true); });
afterEach(cleanup);
it('keeps tool setup without a global switch, research parameters or strategy editor', () => {
  render(<SearchSettings state={panel()} send={vi.fn()} />);
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: '保存联网策略' })).toBeNull();
  expect(screen.queryByRole('button', { name: '恢复默认联网策略' })).toBeNull();
  expect(screen.getByRole('radiogroup', { name: '搜索服务' })).toBeTruthy();
});
it('keeps six providers, masks keys, requests permissions in the gesture then tests', async () => {
  const send = vi.fn(async (_command: Command) => ({ ok: true as const }));
  let grant!: (accepted: boolean) => void;
  permissionRequest.mockImplementationOnce(() => new Promise<boolean>(resolve => { grant = resolve; }));
  render(<SearchSettings state={panel()} send={send} />);
  expect(screen.getAllByRole('radio')).toHaveLength(7);
  fireEvent.click(screen.getByRole('radio', { name: /Tavily/ }));
  const input = screen.getByLabelText('API Key') as HTMLInputElement;
  expect(input.type).toBe('password'); expect(input.value).toBe('');
  fireEvent.change(input, { target: { value: 'own-key' } });
  fireEvent.click(screen.getByRole('button', { name: '授权并启用' }));
  // Synchronous click-handler observation proves the request was initiated inside the gesture.
  expect(browser.permissions.request).toHaveBeenCalledWith({ origins: ['https://api.tavily.com/*'] });
  expect(send).not.toHaveBeenCalled(); grant(true);
  await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'testSearch', providerId: 'tavily' }));
  expect(permissionRequest.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
  expect(send.mock.calls.map(([command]) => command)).toEqual([
    { type: 'saveSearchConfig', providerId: 'tavily', credentials: { apiKey: 'own-key' } },
    { type: 'testSearch', providerId: 'tavily' },
  ]);
  expect(input.value).toBe('');
  expect(screen.queryByRole('combobox', { name: '来源读取' })).toBeNull();
});

it('shows shared receiver boundaries before initial key setup', () => {
  const state = panel(); state.settings.provider = 'zhipu';
  state.settings.search.providerName = 'Firecrawl'; state.settings.search.sourceCapabilities.providerContent = true;
  render(<Setup settings={state.settings} onOpenSettings={vi.fn()} />);
  expect(screen.getByText(/智谱（Zhipu） 接收当前文章正文/)).toBeTruthy();
  expect(screen.getByText(/内容接口（Firecrawl）接收所选来源 URL/)).toBeTruthy();
  expect(screen.getByText(/自己的认证通道/)).toBeTruthy();
});

it('denied provider permission prevents saving configuration and connection testing', async () => {
  permissionRequest.mockResolvedValueOnce(false);
  const send = vi.fn(async (_command: Command) => ({ ok: true as const }));
  render(<SearchSettings state={panel()} send={send} />);
  fireEvent.click(screen.getByRole('radio', { name: /Tavily/ }));
  fireEvent.click(screen.getByRole('button', { name: '授权并启用' }));
  expect(browser.permissions.request).toHaveBeenCalledWith({ origins: ['https://api.tavily.com/*'] });
  await screen.findByText(/没有授予搜索服务的访问权限/);
  expect(send).not.toHaveBeenCalled();
});
