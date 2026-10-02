// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Conversation } from '../src/sidepanel/components/Conversation';

it('仅上滑就出现回到底部入口，不必等新消息', () => {
  render(<Conversation updateKey="1" followRequest={0}><p>已有对话</p></Conversation>);
  const area = screen.getByRole('region', { name: '对话记录' });
  Object.defineProperties(area, { scrollHeight: { value: 1000 }, clientHeight: { value: 300 } });
  area.scrollTop = 120;
  fireEvent.scroll(area);
  const latest = screen.queryByRole('button', { name: '回到最新消息' });
  expect(latest).not.toBeNull();
  fireEvent.click(latest!);
  expect(area.scrollTop).toBe(1000);
  expect(screen.queryByRole('button', { name: '回到最新消息' })).toBeNull();
});

it('初次打开长历史直接停在最新消息', () => {
  const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
  const viewport = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  try {
    render(<Conversation updateKey="1" followRequest={0}><p>长历史</p></Conversation>);
    expect(screen.getByRole('region', { name: '对话记录' }).scrollTop).toBe(1000);
  } finally { height.mockRestore(); viewport.mockRestore(); }
});

it('回看消息时不被新内容拉走，可以主动回到最新', () => {
  const { rerender } = render(<Conversation updateKey="1" followRequest={0}><p>旧消息</p></Conversation>);
  const area = screen.getByRole('region', { name: '对话记录' });
  Object.defineProperties(area, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 300 } });
  area.scrollTop = 100;
  fireEvent.scroll(area);
  rerender(<Conversation updateKey="2" followRequest={0}><p>旧消息</p><p>新回答</p></Conversation>);
  expect(area.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole('button', { name: '回到最新消息' }));
  expect(area.scrollTop).toBe(1000);
});

it('主动发送会带到当前消息，切换模式后恢复回看位置', () => {
  const { rerender } = render(<Conversation updateKey="1" followRequest={0}><p>消息</p></Conversation>);
  const area = screen.getByRole('region', { name: '对话记录' });
  Object.defineProperties(area, { scrollHeight: { value: 1000 }, clientHeight: { value: 300 } });
  area.scrollTop = 120;
  fireEvent.scroll(area);
  rerender(<Conversation active={false} updateKey="1" followRequest={0}><p>消息</p></Conversation>);
  area.scrollTop = 0;
  rerender(<Conversation active updateKey="1" followRequest={0}><p>消息</p></Conversation>);
  expect(area.scrollTop).toBe(120);
  rerender(<Conversation active updateKey="2" followRequest={1}><p>消息</p><p>我发的话</p></Conversation>);
  expect(area.scrollTop).toBe(1000);
});

it('隐藏模式有新回答时，返回后仍能回到最新消息', () => {
  const { rerender } = render(<Conversation updateKey="1" followRequest={0}><p>消息</p></Conversation>);
  const area = screen.getByRole('region', { name: '对话记录' });
  Object.defineProperties(area, { scrollHeight: { value: 1000 }, clientHeight: { value: 300 } });
  area.scrollTop = 120;
  fireEvent.scroll(area);
  rerender(<Conversation active={false} updateKey="2" followRequest={0}><p>新回答</p></Conversation>);
  rerender(<Conversation active updateKey="2" followRequest={0}><p>新回答</p></Conversation>);
  expect(area.scrollTop).toBe(120);
  expect(screen.getByRole('button', { name: '回到最新消息' })).toBeTruthy();
});

it('captures focus movement before detail activation masks the queued scroll, retaining review on updates', () => {
  const content = <details className="research-details"><summary>本轮搜索详情</summary><p>来源</p></details>;
  const { rerender } = render(<Conversation updateKey="1" followRequest={0}>{content}</Conversation>);
  const area = screen.getByRole('region', { name: '对话记录' });
  Object.defineProperties(area, { scrollHeight: { value: 1000 }, clientHeight: { value: 300 } });
  area.scrollTop = 700; fireEvent.scroll(area);
  // Native focus can move the viewport synchronously before its scroll event runs.
  area.scrollTop = 120;
  fireEvent.click(screen.getByText('本轮搜索详情'));
  fireEvent.scroll(area);
  expect(screen.queryByRole('button', { name: '回到最新消息' })).not.toBeNull();
  rerender(<Conversation updateKey="2" followRequest={0}>{content}<p>新消息</p></Conversation>);
  expect(area.scrollTop).toBe(120);
  expect(screen.getByRole('button', { name: '回到最新消息' }).textContent).toContain('有新消息');
});

it('uses pre-toggle bottom geometry even when an earlier layout left the same saved offset', () => {
  render(<Conversation updateKey="1" followRequest={0}><details className="research-details"><summary>本轮搜索详情</summary></details></Conversation>);
  const area = screen.getByRole('region', { name: '对话记录' });
  Object.defineProperties(area, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 300 } });
  area.scrollTop = 700; fireEvent.scroll(area);
  Object.defineProperty(area, 'scrollHeight', { value: 1400 });
  fireEvent.click(screen.getByText('本轮搜索详情'));
  expect(screen.queryByRole('button', { name: '回到最新消息' })).not.toBeNull();
});
