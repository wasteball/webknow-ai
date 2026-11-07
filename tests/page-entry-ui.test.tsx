// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PageEntry } from '../src/sidepanel/components/PageEntry';
import { Opening } from '../src/sidepanel/components/bits';

describe('换页入口界面', () => {
  it('只有一个清楚的阅读主操作，点下去才读这一页', () => {
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
    fireEvent.click(screen.getByRole('button', { name: '开始阅读' }));
    expect(onPick.mock.calls.map((call) => call[0])).toEqual(['summary']);
    expect(screen.queryByRole('button', { name: '出几个问题' })).toBeNull();
    expect(screen.queryByRole('button', { name: '让它问我' })).toBeNull();
    expect(screen.getByText(/点击后，我才读这一页/)).toBeTruthy();
    expect(screen.getByText(/换页不会自动读/)).toBeTruthy();
  });

  it('有当前页标题时写出来，未确认外发时总结按钮带上确认', () => {
    render(
      <Opening pageUrl="https://www.example.com/a" title="城市配送试点研究">
        <PageEntry
          pageTitle="城市配送试点研究"
          phase="READY_TO_START"
          outboundConfirmed={false}
          busy={false}
          askHost={false}
          onPick={() => {}}
        />
      </Opening>,
    );

    // 标题与网站名只在开场卡里出现一次。
    expect(screen.getAllByText('城市配送试点研究')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '城市配送试点研究' })).toBeTruthy();
    expect(screen.getByText('example.com')).toBeTruthy();
    const summary = screen.getByRole('button', { name: /开始阅读/ }) as HTMLButtonElement;
    expect(summary.textContent).toContain('我确认');
    expect(summary.disabled).toBe(false);
    expect(screen.queryByText(/允许读取你打开的网页/)).toBeNull();
  });
});
