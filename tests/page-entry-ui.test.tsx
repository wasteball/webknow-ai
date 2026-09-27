// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PageEntry } from '../src/sidepanel/components/PageEntry';

describe('换页入口界面', () => {
  it('给出总结摘要等按钮，点下去才是读这一页', () => {
    const onPick = vi.fn();
    render(
      <PageEntry
        pageTitle=""
        phase="STALE"
        outboundConfirmed
        busy={false}
        askHost
        onPick={onPick}
      />,
    );

    expect(screen.queryByRole('button', { name: /开始伴读/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '总结摘要' }));
    fireEvent.click(screen.getByRole('button', { name: '出几个问题' }));
    fireEvent.click(screen.getByRole('button', { name: '让它问我' }));
    expect(onPick.mock.calls.map((call) => call[0])).toEqual(['summary', 'questions', 'learn']);
    expect(screen.getByText(/点一个，我才读这一页/)).toBeTruthy();
    expect(screen.getByText(/换页不会自动读/)).toBeTruthy();
  });

  it('有当前页标题时写出来，未确认外发时总结按钮带上确认', () => {
    render(
      <PageEntry
        pageTitle="城市配送试点研究"
        phase="READY_TO_START"
        outboundConfirmed={false}
        busy={false}
        askHost={false}
        onPick={() => {}}
      />,
    );

    expect(screen.getByText(/城市配送试点研究/)).toBeTruthy();
    const summary = screen.getByRole('button', { name: /总结摘要/ }) as HTMLButtonElement;
    expect(summary.textContent).toContain('我确认');
    expect(summary.disabled).toBe(false);
    expect(screen.queryByText(/允许读取你打开的网页/)).toBeNull();
  });
});
