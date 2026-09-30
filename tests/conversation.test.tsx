// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Learning } from '../src/sidepanel/components/Learning';
import { Reading } from '../src/sidepanel/components/Reading';
import { panel } from './helpers/panel';

const question = { id: 'q1', text: '文章里的适用范围是什么？', multi: false,
  choices: [{ id: 'A', label: '仅有三个团队' }, { id: 'B', label: '所有城市' }] };

describe('学习也是对话流', () => {
  it('等待首问时，禁用的回答按钮变成可用的停止按钮', () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const state = panel({ learning: { goal: '核心', promptVersion: '1', used: 0,
      status: 'active', current: null, log: [] } });
    const { rerender } = render(<Learning state={state} send={send} />);
    expect((screen.getByRole('button', { name: '回答' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<Learning state={{ ...state, busy: { kind: 'learn', draft: '', reasoning: '', chars: 0 } }} send={send} />);
    const stop = screen.getByRole('button', { name: '停止' }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    expect(send).toHaveBeenCalledWith({ type: 'stop', tabId: 7 });
  });
  it('停止第一问后可以直接继续提问', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    render(<Learning state={panel({ learning: { goal: '核心', promptVersion: '1', used: 0,
      status: 'active', current: null, log: [] } })} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: '继续提问' }));
    expect(send).toHaveBeenCalledWith({ type: 'learnAssist', tabId: 7, action: 'skip' });
  });
  it('已经结束的选择题只读，不能重新更改答案', () => {
    render(<Learning state={panel({ learning: {
      goal: '核心', promptVersion: '1', used: 1, status: 'closed',
      current: { kind: 'quiz', questions: [question], answerKey: [] },
      log: [{ role: 'quiz', text: question.text, quiz: [question], at: 1 }],
    } })} send={vi.fn(async () => ({ ok: true as const }))} />);
    expect(screen.queryByRole('radio')).toBeNull();
  });
  it('选择题在 AI 消息内出现一次，底部只保留提交入口', () => {
    const state = panel({ learning: {
      goal: '核心', promptVersion: '1', used: 1, status: 'active',
      current: { kind: 'quiz', questions: [question], answerKey: [] },
      log: [{ role: 'quiz', text: question.text, quiz: [question], at: 1 }],
    } });
    render(<Learning state={state} send={vi.fn(async () => ({ ok: true as const }))} />);
    expect(screen.getAllByText(question.text)).toHaveLength(1);
    expect(document.querySelector('.chat')?.contains(screen.getByRole('radio', { name: '仅有三个团队' }))).toBe(true);
    expect(document.querySelector('.dock')?.querySelector('fieldset')).toBeNull();
  });

  it('未开始的方向在 AI 消息里，输入保持为聊天框', () => {
    render(<Learning state={panel()} send={vi.fn(async () => ({ ok: true as const }))} />);
    const direction = screen.getByRole('button', { name: '这篇文章的核心内容' });
    expect(document.querySelector('.chat')?.contains(direction)).toBe(true);
    expect(screen.getByLabelText('自己写一个方向').tagName).toBe('TEXTAREA');
  });

  it('作答后立即看见自己的消息，并保留生成期间新写的内容', async () => {
    let resolve: (value: { ok: true }) => void = () => {};
    const send = vi.fn(() => new Promise<{ ok: true }>((r) => { resolve = r; }));
    const state = panel({ learning: { goal: '核心', promptVersion: '1', used: 1, status: 'active',
      current: { kind: 'open', question: '这句话是什么意思？', hintUsed: false },
      log: [{ role: 'question', text: '这句话是什么意思？', at: 1 }],
    } });
    const { rerender } = render(<Learning state={state} send={send} />);
    const input = screen.getByLabelText('用自己的话回答') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '只有试点团队适用' } });
    fireEvent.submit(input.closest('form')!);
    expect(document.querySelector('.bubble.user')?.textContent).toContain('只有试点团队适用');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '还想补充一句' } });
    rerender(<Learning state={{ ...state, learning: { ...state.learning!, log: [...state.learning!.log,
      { role: 'answer', text: '只有试点团队适用', at: 2 }, { role: 'feedback', text: '对。', at: 3 }] } }} send={send} />);
    await act(async () => resolve({ ok: true }));
    expect(input.value).toBe('还想补充一句');
  });

  it('另一模式生成时，输入草稿可写但不会发出必然失败的请求', () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    render(<Reading state={panel({ busy: { kind: 'learn', draft: '', reasoning: '', chars: 0 } })} send={send} />);
    const input = screen.getByLabelText('向这篇文章提问');
    fireEvent.change(input, { target: { value: '我想问一个问题' } });
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
  });
});
