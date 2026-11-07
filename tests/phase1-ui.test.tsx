// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: { runtime: { getURL: (path: string) => `chrome-extension://test${path}`, getManifest: () => ({ version: '0' }) },
    permissions: { request: vi.fn(async () => true) } },
}));

import { LearningEntry } from '../src/sidepanel/components/LearningEntry';
import { Reading } from '../src/sidepanel/components/Reading';
import { Settings } from '../src/sidepanel/components/Settings';
import { panel } from './helpers/panel';

it('导师不打分：判定、对几题、掌握标签都不出现在界面上，只看说的话', () => {
  render(<LearningEntry diagrams={false} entry={{ role: 'feedback', text: '对，你抓到了核心。', at: 1,
    verdict: 'partial', score: { correct: 1, total: 2 }, mastery: 'basic' }} />);
  expect(screen.getByText('对，你抓到了核心。')).toBeTruthy();
  for (const label of ['对了一半', '1/2 题正确', '基本理解']) expect(screen.queryByText(label)).toBeNull();
});

it('有引用时不写问题也能直接发', () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  render(<Reading state={panel({ quote: { id: 'q1', text: '选中的一段话', blockId: null } })} send={send} />);
  const submit = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ask', question: '这段是什么意思？', quote: '选中的一段话' }));
});

it('设置抽屉：分组列表 → 二级页，返回回到列表，Esc 关闭', () => {
  const onClose = vi.fn();
  render(<Settings variant="drawer" state={panel()} send={vi.fn()} notice={null} onDismissNotice={() => {}} onClose={onClose} />);
  for (const name of ['AI 服务', '读法', '阅读偏好', '外观', '联网搜索', '知识库', '隐私与数据', '关于与帮助']) {
    expect(screen.getByRole('button', { name: new RegExp(name) })).toBeTruthy();
  }
  fireEvent.click(screen.getByRole('button', { name: /隐私与数据/ }));
  expect(screen.getByRole('dialog', { name: '隐私与数据' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回设置' }));
  expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
});
