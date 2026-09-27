// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PanelState } from '../src/core/protocol';
import type { LearningState } from '../src/core/session';
import { Learning } from '../src/sidepanel/components/Learning';
import { Reading } from '../src/sidepanel/components/Reading';

function panel(over: Partial<PanelState> = {}): PanelState {
  return {
    tabId: 1,
    pageUrl: 'https://example.com/a',
    pageTitle: '一篇文章',
    permission: 'granted',
    phase: 'READY',
    sessionState: 'READY',
    hasKey: true,
    settings: {
      model: 'deepseek-flash',
      prompts: {},
      skillChoices: {},
      customSkills: [],
      learningBudget: 5,
      learningStyle: 'open',
      provider: 'deepseek',
      providerKeys: { deepseek: true, zhipu: false },
      models: {},
      search: { enabled: false, providerName: null, hasCredentials: false },
      ima: { enabled: false, kbName: null },
      maxBubbles: 4,
      summaryLength: 'medium',
      fontSize: 'normal',
      diagrams: 'off',
      thinking: 'off',
    },
    outboundConfirmed: true,
    completeness: null,
    guide: { summary: '摘要', bubbles: [] },
    chat: [],
    learning: null,
    quote: null,
    busy: null,
    error: null,
    budget: { used: 0, total: 5 },
    unsupportedReason: null,
    ...over,
  };
}

function openLearning(): LearningState {
  return {
    goal: '核心',
    promptVersion: '1',
    used: 1,
    current: { kind: 'open', question: '这句话在说什么', hintUsed: false },
    status: 'active',
    log: [{ role: 'question', text: '这句话在说什么', at: 1 }],
  };
}

describe('对话里的发送和停止', () => {
  it('问 AI 生成时正文只有正在写的字，停止在输入框里，和发送是同一个位置', () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const { rerender } = render(
      <Reading
        state={panel({
          busy: { kind: 'answer', chars: 4, draft: '半截回答', reasoning: '' },
        })}
        send={send}
      />,
    );

    const drafting = document.querySelector('article.drafting');
    expect(drafting?.textContent).toContain('半截回答');
    expect(drafting?.querySelector('button')).toBeNull();

    const field = document.querySelector('.composer-field');
    const stop = screen.getByRole('button', { name: '停止' });
    const box = screen.getByPlaceholderText('有什么不懂的？');
    expect(field?.contains(stop)).toBe(true);
    expect(field?.contains(box)).toBe(true);
    expect(screen.getAllByRole('button', { name: '停止' })).toHaveLength(1);

    fireEvent.click(stop);
    expect(send).toHaveBeenCalledWith({ type: 'stop', tabId: 1 });

    fireEvent.change(box, { target: { value: '下一句' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);

    rerender(<Reading state={panel()} send={send} />);
    const sendButton = screen.getByRole('button', { name: '发送' });
    expect(document.querySelector('.composer-field')?.contains(sendButton)).toBe(true);
    expect(document.querySelector('.composer-field')?.contains(screen.getByPlaceholderText('有什么不懂的？'))).toBe(true);
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
  });

  it('问 AI 还没写出字时，停止仍在输入框里，正文状态条上没有按钮', () => {
    render(
      <Reading
        state={panel({ busy: { kind: 'answer', chars: 0, draft: '', reasoning: '' } })}
        send={vi.fn(async () => ({ ok: true as const }))}
      />,
    );

    expect(document.querySelector('.busy')?.querySelector('button')).toBeNull();
    expect(screen.getByText('正在回答…')).toBeTruthy();
    const field = document.querySelector('.composer-field');
    expect(field?.contains(screen.getByRole('button', { name: '停止' }))).toBe(true);
  });

  it('AI 问生成时输入框留着，停止在输入框里，辅助按钮按不了', () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    render(
      <Learning
        state={panel({
          phase: 'LEARNING',
          learning: openLearning(),
          busy: { kind: 'learn', chars: 4, draft: '先看定义', reasoning: '' },
        })}
        send={send}
      />,
    );

    const drafting = document.querySelector('article.drafting');
    expect(drafting?.textContent).toContain('先看定义');
    expect(drafting?.querySelector('button')).toBeNull();

    const box = screen.getByPlaceholderText('用自己的话说说看…');
    const stop = screen.getByRole('button', { name: '停止' });
    expect(document.querySelector('.composer-field')?.contains(box)).toBe(true);
    expect(document.querySelector('.composer-field')?.contains(stop)).toBe(true);
    expect((screen.getByRole('button', { name: '提示' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(stop);
    expect(send).toHaveBeenCalledWith({ type: 'stop', tabId: 1 });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AI 问还在想下一问时，底部输入框里可以停止', () => {
    render(
      <Learning
        state={panel({
          phase: 'LEARNING',
          learning: { ...openLearning(), current: null },
          busy: { kind: 'learn', chars: 0, draft: '', reasoning: '' },
        })}
        send={vi.fn(async () => ({ ok: true as const }))}
      />,
    );

    expect(document.querySelector('.busy')?.querySelector('button')).toBeNull();
    expect(document.querySelector('.composer-field')?.contains(screen.getByRole('button', { name: '停止' }))).toBe(true);
  });
});
