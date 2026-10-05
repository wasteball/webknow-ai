// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Learning } from '../src/sidepanel/components/Learning';
import { Reading } from '../src/sidepanel/components/Reading';
import { DEFAULT_LEARN_GOAL } from '../src/core/learn-policy';
import { panel } from './helpers/panel';

const question = { id: 'q1', text: '文章里的适用范围是什么？', multi: false,
  choices: [{ id: 'A', label: '仅有三个团队' }, { id: 'B', label: '所有城市' }] };

describe('学习也是对话流', () => {
  it('文章依据默认收起，展开后仍可回跳核对', () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    render(<Reading state={panel({ chat: [{ id: 't1', question: '为什么？', answer: '因为样本有限。', source: 'original',
      citations: [{ blockId: 'b_1' }], references: [], unanswered: [], at: 1 }] })} send={send} />);
    const toggle = screen.queryByText('查看依据');
    expect(toggle).not.toBeNull();
    expect(screen.queryByRole('button', { name: '看看原文1' })).toBeNull();
    fireEvent.click(toggle!);
    fireEvent.click(screen.getByRole('button', { name: '回到文中 1' }));
    expect(send).toHaveBeenCalledWith({ type: 'jump', tabId: 7, blockId: 'b_1' });
  });

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

  it('首次进入由 AI 先问，隐藏或切换回来不重复开场', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const state = panel();
    const { rerender } = render(<Learning state={state} send={send} active={false} />);
    expect(send).not.toHaveBeenCalled();
    rerender(<Learning state={state} send={send} active />);
    expect(send).toHaveBeenCalledWith({ type: 'learnStart', tabId: 7, goal: DEFAULT_LEARN_GOAL });
    expect(screen.queryByRole('button', { name: '这篇文章的核心内容' })).toBeNull();
    expect(document.querySelector('.bubble.user')).toBeNull();
    await act(async () => {});
    rerender(<Learning state={state} send={send} active={false} />);
    rerender(<Learning state={state} send={send} active />);
    expect(send).toHaveBeenCalledOnce();
  });

  it('摘要失败时 AI 问仍会主动开始首问', () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    render(<Learning state={panel({ guide: null, error: { code: 'BAD_OUTPUT', message: '摘要失败', retryable: true } })} send={send} active />);
    expect(send).toHaveBeenCalledWith({ type: 'learnStart', tabId: 7, goal: DEFAULT_LEARN_GOAL });
  });

  it('摘要失败时问 AI 保留输入并提供重试摘要', () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    render(<Reading state={panel({ guide: null, error: { code: 'BAD_OUTPUT', message: '摘要失败', retryable: true } })} send={send} />);
    expect(screen.getByText(/摘要暂时没生成/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试摘要' }));
    expect(send).toHaveBeenCalledWith({ type: 'start', tabId: 7 });
    expect(screen.getByLabelText('向这篇文章提问')).toBeTruthy();
  });  it('另一模式生成结束后才开始首问，失败不循环重发', async () => {
    const send = vi.fn(async () => ({ ok: false as const, error: { code: 'INTERNAL' as const, message: '失败', retryable: true } }));
    const state = panel();
    const { rerender } = render(<Learning state={{ ...state, busy: { kind: 'answer', chars: 0, draft: '', reasoning: '' } }} send={send} />);
    expect(send).not.toHaveBeenCalled();
    rerender(<Learning state={state} send={send} />);
    await act(async () => {});
    expect(send).toHaveBeenCalledOnce();
    rerender(<Learning state={state} send={send} active={false} />);
    rerender(<Learning state={state} send={send} active />);
    expect(send).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '重新提问' }));
    expect(send).toHaveBeenCalledTimes(2);
    await act(async () => {});
  });

  it('单选和多选作答提交后立即作为用户消息出现', async () => {
    let finish!: (value: { ok: true }) => void;
    const send = vi.fn(() => new Promise<{ ok: true }>((resolve) => { finish = resolve; }));
    const multi = { ...question, multi: true };
    const state = panel({ learning: { goal: '核心', promptVersion: '1', used: 1, status: 'active',
      current: { kind: 'quiz', questions: [multi], answerKey: [] },
      log: [{ role: 'quiz', text: multi.text, quiz: [multi], at: 1 }] } });
    render(<Learning state={state} send={send} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '仅有三个团队' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '所有城市' }));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(document.querySelector('.bubble.user')?.textContent).toContain('仅有三个团队、所有城市');
    expect(send).toHaveBeenCalledWith({ type: 'learnAnswer', tabId: 7, text: '（选择题作答）', choices: [{ questionId: 'q1', choiceIds: ['A', 'B'] }] });
    await act(async () => finish({ ok: true }));
  });

  it('即使下一题文字相同，上一题的选择也不能自动带入', () => {
    const learning = { goal: '核心', promptVersion: '1', used: 1, status: 'active' as const,
      current: { kind: 'quiz' as const, questions: [question], answerKey: [] },
      log: [{ role: 'quiz' as const, text: question.text, quiz: [question], at: 1 }] };
    const send = vi.fn(async () => ({ ok: true as const }));
    const { rerender } = render(<Learning state={panel({ learning })} send={send} />);
    const radio = screen.getByRole('radio', { name: '仅有三个团队' }) as HTMLInputElement;
    fireEvent.click(radio);
    expect(radio.checked).toBe(true);
    rerender(<Learning state={panel({ learning: { ...learning, used: 2, log: [...learning.log,
      { role: 'quiz', text: question.text, quiz: [question], at: 2 }] } })} send={send} />);
    expect((screen.getByRole('radio', { name: '仅有三个团队' }) as HTMLInputElement).checked).toBe(false);
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

it('opening completed research details preserves scroll position, draft and local citation jumping', () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  const reference = { sourceId: 's1', title: '官方发布说明', url: 'https://example.org/release', domain: 'example.org', publishedAt: '2026-10-01', retrievedAt: '2026-10-02T08:00:00Z', readStatus: 'read' as const };
  render(<Reading state={panel({ chat: [{ id: 't1', question: '最新版本？', answer: '可以确认的版本', source: 'extended', citations: [{ blockId: 'b_1' }], references: [reference.url], webReferences: [reference], unanswered: [], at: 1 }] })} send={send} />);
  const input = screen.getByLabelText('向这篇文章提问') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '保留草稿' } });
  const scroll = screen.getByRole('region', { name: '对话记录' });
  Object.defineProperties(scroll, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
  scroll.scrollTop = 150;
  fireEvent.scroll(scroll);
  const summary = screen.getByText('本轮搜索详情');
  fireEvent.click(summary);
  expect(scroll.scrollTop).toBe(150);
  expect(input.value).toBe('保留草稿');
  expect(screen.getByRole('link', { name: '官方发布说明' }).getAttribute('href')).toBe(reference.url);
  fireEvent.click(screen.getByText('查看依据'));
  fireEvent.click(screen.getByRole('button', { name: '回到文中 1' }));
  expect(send).toHaveBeenCalledWith({ type: 'jump', tabId: 7, blockId: 'b_1' });
});

it.each([600, 150])('details resize preserves scroll %s while messages and latest keep their normal behavior', (position) => {
  let resize = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { if (target.classList.contains('chat-scroll')) resize = () => this.callback([], this as unknown as ResizeObserver); }
    disconnect() {}
  });
  try {
    const reference = { sourceId: 's1', title: '官方发布说明', url: 'https://example.org/release', domain: 'example.org', publishedAt: null, retrievedAt: '2026-10-02', readStatus: 'read' as const };
    const turn = { id: 't1', question: '最新版本？', answer: '答案', source: 'extended' as const, citations: [], references: [reference.url], webReferences: [reference], unanswered: [], at: 1 };
    const state = panel({ chat: [turn] });
    const send = vi.fn(async () => ({ ok: true as const }));
    const { rerender } = render(<Reading state={state} send={send} />);
    const scroll = screen.getByRole('region', { name: '对话记录' });
    let height = 1000;
    Object.defineProperties(scroll, { scrollHeight: { get: () => height }, clientHeight: { value: 400 } });
    scroll.scrollTop = position;
    fireEvent.scroll(scroll);
    const summary = screen.getByText('本轮搜索详情');
    fireEvent.click(summary);
    height = 1600;
    act(resize);
    expect(scroll.scrollTop).toBe(position);
    fireEvent.click(summary);
    height = 1000;
    act(resize);
    expect(scroll.scrollTop).toBe(position);
    height = 1800;
    rerender(<Reading state={{ ...state, chat: [...state.chat, { ...turn, id: 't2', webReferences: [] }] }} send={send} />);
    expect(scroll.scrollTop).toBe(position === 600 ? 1800 : 150);
    if (position === 150) {
      fireEvent.click(screen.getByRole('button', { name: '回到最新消息' }));
      expect(scroll.scrollTop).toBe(1800);
    }
  } finally { vi.unstubAllGlobals(); }
});
