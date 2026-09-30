// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Completeness } from '../src/core/blocks';
import { ScopeLine } from '../src/sidepanel/components/bits';

function completeness(over: Partial<Completeness> = {}): Completeness {
  return {
    scope: 'readability-article', text: { status: 'parsed', found: 5, captured: 5 },
    images: { status: 'partial', found: 3, captured: 1 }, tables: { status: 'not-present', found: 0, captured: 0 },
    frames: { status: 'not-present', found: 0, captured: 0 }, excludedBlocks: 0, truncated: false,
    warnings: [], textRange: { characters: 1860, first: { blockId: 'b_1', text: '第一段读取内容' }, last: { blockId: 'b_9', text: '最后一段读取内容' } },
    ...over,
  };
}

it('说明已加载正文和未读图片，不再让读者猜段落数或全文比例', () => {
  const { container } = render(<ScopeLine completeness={completeness()} />);
  expect(container.textContent).toContain('当前加载');
  expect(container.textContent).toContain('1860');
  expect(container.textContent).toMatch(/2.*未读/);
  expect(container.textContent).not.toMatch(/段文字|文字块|100%|全文已读/);
});

it('起止内容可核对，并沿用真实块身份回跳', () => {
  const jump = vi.fn();
  render(<ScopeLine completeness={completeness()} onJump={jump} />);
  const toggle = screen.queryByText('核对读取范围');
  expect(toggle).not.toBeNull();
  fireEvent.click(toggle!);
  expect(screen.getByText('第一段读取内容')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '回到正文开头' }));
  fireEvent.click(screen.getByRole('button', { name: '回到正文结尾' }));
  expect(jump.mock.calls).toEqual([['b_1'], ['b_9']]);
});

it('正文缺失和未展开警告仍明示，不重复同一条图片遗漏', () => {
  const { container } = render(<ScopeLine completeness={completeness({
    text: { status: 'partial', found: 7, captured: 5 },
    warnings: ['页面上有「展开全文」，可能还有没展开的内容没有读到。', '有的图片没读到。'],
  })} />);
  expect(container.textContent).toContain('部分');
  expect(container.textContent).toContain('展开全文');
  expect(container.textContent).not.toContain('有的图片没读到');
});

it('已知无法定位的起止内容显示文字说明，不给出可用跳转按钮', () => {
  const value = completeness();
  value.textRange!.first.jumpable = false;
  value.textRange!.last.jumpable = false;
  render(<ScopeLine completeness={value} onJump={vi.fn()} />);
  fireEvent.click(screen.getByText('核对读取范围'));
  expect(screen.queryByRole('button', { name: '回到正文开头' })).toBeNull();
  expect(screen.queryByRole('button', { name: '回到正文结尾' })).toBeNull();
  expect(screen.getByText(/第一段读取内容.*无法定位/)).toBeTruthy();
});

it('页面文字兜底不能宣称已确认完整文章', () => {
  const { container } = render(<ScopeLine completeness={completeness({ scope: 'page-text' })} />);
  expect(container.textContent).toContain('未确认完整文章');
});
