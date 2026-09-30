// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const permission = vi.hoisted(() => vi.fn());
vi.mock('wxt/browser', () => ({ browser: { permissions: { request: permission }, runtime: { getURL: (p: string) => `chrome-extension://test${p}` } } }));
beforeEach(() => { permission.mockReset(); permission.mockResolvedValue(true); });

import type { Command, Reply } from '../src/core/protocol';
import { Settings } from '../src/sidepanel/components/Settings';
import { panel } from './helpers/panel';

function openModel(over = panel(), respond?: (command: Command) => Reply) {
  location.hash = '#model';
  const send = vi.fn(async (command: Command): Promise<Reply> =>
    respond?.(command) ?? { ok: true, data: { models: ['deepseek-flash'] } });
  render(<Settings state={over} send={send} notice={null} onDismissNotice={() => {}} />);
  return send;
}

describe('模型配置与实际使用分开', () => {
  it('智谱必须先获得访问权限，拒绝后保留 Key 且不发送连接请求', async () => {
    permission.mockResolvedValue(false);
    const send = openModel();
    fireEvent.click(screen.getByRole('button', { name: /智谱.*未连接/ }));
    const input = screen.getByLabelText('智谱 的钥匙') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'test.key' } });
    fireEvent.click(screen.getByRole('button', { name: '连接并使用' }));
    await waitFor(() => expect(permission).toHaveBeenCalledWith({ origins: ['https://open.bigmodel.cn/*'] }));
    expect(send.mock.calls.some(([c]) => c.type === 'saveKey')).toBe(false);
    expect(input.value).toBe('test.key');
  });
  it('点另一家只打开它的配置，不切换使用服务', async () => {
    const send = openModel();
    fireEvent.click(screen.getByRole('button', { name: /智谱.*未连接/ }));
    expect(screen.getByLabelText('智谱 的钥匙')).toBeTruthy();
    expect(send.mock.calls.some(([c]) => c.type === 'saveSettings')).toBe(false);
    expect(screen.getByText('当前使用 DeepSeek')).toBeTruthy();
  });

  it('连接另一家成功后才使用，失败时留下输入且不切换', async () => {
    const send = openModel(panel(), (command) => command.type === 'saveKey'
      ? { ok: false, error: { code: 'KEY_INVALID', message: '钥匙无效', retryable: false } }
      : { ok: true, data: { models: ['deepseek-flash'] } });
    fireEvent.click(screen.getByRole('button', { name: /智谱.*未连接/ }));
    const input = screen.getByLabelText('智谱 的钥匙') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'test.key' } });
    fireEvent.click(screen.getByRole('button', { name: '连接并使用' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'saveKey', provider: 'zhipu', key: 'test.key' }));
    expect(input.value).toBe('test.key');
    expect(send.mock.calls.some(([c]) => c.type === 'saveSettings')).toBe(false);
  });

  it('另一家已经连接时，点击使用才切换，不索取或显示保存过的 Key', async () => {
    const state = panel();
    state.settings.providerKeys.zhipu = true;
    const send = openModel(state);
    fireEvent.click(screen.getByRole('button', { name: /智谱.*已连接/ }));
    expect(screen.queryByLabelText('智谱 的钥匙')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '使用智谱' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'saveSettings', patch: { provider: 'zhipu' } }));
  });

  it('当前模型细节按需展开，默认配置不需要理解模型 ID', async () => {
    openModel();
    await waitFor(() => expect(screen.getByText('高级选项')).toBeTruthy());
    const details = screen.getByText('高级选项').closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText('高级选项'));
    expect(screen.getByLabelText('用哪个模型')).toBeTruthy();
  });

  it('正在生成时不允许切换使用服务', () => {
    const state = panel({ busy: { kind: 'answer', chars: 0, draft: '', reasoning: '' } });
    state.settings.providerKeys.zhipu = true;
    openModel(state);
    const other = screen.getByRole('button', { name: /智谱.*已连接/ }) as HTMLButtonElement;
    expect(other.disabled).toBe(true);
  });
});
