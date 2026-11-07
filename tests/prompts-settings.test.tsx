// @vitest-environment jsdom
import { panel as sharedPanel } from './helpers/panel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: { runtime: { getURL: (path: string) => `chrome-extension://test${path}` } },
}));

import type { Command, PanelState } from '../src/core/protocol';
import { LEARN_DEFAULT_POLICY } from '../src/core/prompts/learn';
import { BUILTIN_SKILLS } from '../src/core/skills';
import { Settings } from '../src/sidepanel/components/Settings';

/**
 * 提示词这一页的验收点只有一条：看到的就是生效的。
 *
 * 从前这里是「默认 / 一排模板 / 自己写」的单选。点一个模板，后台确实换了策略，
 * 屏幕上一个字都没动——用户只能得出「选了没变化」。下面的用例把「点了之后
 * 编辑框里出现那份正文」和「保存下去的就是框里的文字」钉住。
 */

function panel(over: Partial<PanelState['settings']> = {}): PanelState {
  return {
    tabId: 1,
    pageUrl: 'https://example.com/a',
    pageTitle: '一篇文章',
    permission: 'granted',
    phase: 'READY',
    sessionState: 'READY',
    hasKey: true,
    settings: {
      model: 'deepseek-chat',
      prompts: {},
      customSkills: [],
      learningStyle: 'mixed',
      provider: 'deepseek',
      providerKeys: { deepseek: true, zhipu: false },
      models: {},
      search: sharedPanel().settings.search,
      ima: { enabled: false, kbName: null },
      maxBubbles: 3,
      summaryLength: 'medium',
      fontSize: 'normal',
      diagrams: 'auto',
      thinking: 'off',
      ...over,
    },
    outboundConfirmed: true,
    completeness: null,
    guide: null,
    chat: [],
    learning: null,
    quote: null,
    busy: null,
    error: null,
    rounds: 0,
    unsupportedReason: null,
  };
}

function openPrompts(state: PanelState) {
  const sent: Command[] = [];
  const send = vi.fn(async (command: Command) => {
    sent.push(command);
    return { ok: true as const };
  });
  const view = render(<Settings state={state} send={send} notice={null} onDismissNotice={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /读法/ }));
  fireEvent.click(screen.getByRole('tab', { name: '怎么考你' }));
  fireEvent.click(screen.getByText('自己写，或在这套基础上改'));
  return { sent, view, send };
}

function learnBox(): HTMLTextAreaElement {
  return screen.getByLabelText('怎么考你：现在照着做的那段话') as HTMLTextAreaElement;
}

/**
 * 读法（原“提示词”）的验收点仍是：看到的就是生效的。
 * 现成方法点一下就换成那一套并保存；编辑框里永远是正在生效的正文。
 */
describe('设置 - 读法', () => {
  it('没改过时选中“默认”，框里直接就是内置默认那段话', () => {
    openPrompts(panel());
    expect(learnBox().value).toBe(LEARN_DEFAULT_POLICY);
    expect(screen.getByRole('radio', { name: /默认/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getAllByText('出厂默认').length).toBeGreaterThan(0);
  });

  it('改过之后，框里是自己的那段话，并标出「你改过」「自己写的」', () => {
    openPrompts(panel({ prompts: { learn: '只问一句话能答的问题。' } }));
    expect(learnBox().value).toBe('只问一句话能答的问题。');
    expect(screen.getAllByText('你改过').length).toBe(1);
    expect(screen.getByRole('radio', { name: /自己写的/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('点一套现成方法就保存成那一套，并在列表里标为选中', async () => {
    const template = BUILTIN_SKILLS.find((skill) => skill.target === 'learn');
    if (!template) throw new Error('缺少内置模板');
    const { sent, view, send } = openPrompts(panel());
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(template.name) }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual({ type: 'saveSettings', patch: { prompts: { learn: template.body } } });
    view.rerender(<Settings state={panel({ prompts: { learn: template.body } })} send={send} notice={null} onDismissNotice={() => {}} />);
    expect(screen.getByRole('radio', { name: new RegExp(template.name) }).getAttribute('aria-checked')).toBe('true');
    expect(learnBox().value).toBe(template.body);
  });

  it('自己写：保存下去的就是框里的文字', async () => {
    const { sent } = openPrompts(panel());
    fireEvent.change(learnBox(), { target: { value: '每次只问一件事。' } });
    expect(screen.getByText(/改完要点保存才会生效/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual({
      type: 'saveSettings',
      patch: { prompts: { learn: '每次只问一件事。' } },
    });
  });

  it('恢复默认：框里换回内置默认，并且把覆盖清掉（存空串）', async () => {
    const { sent } = openPrompts(panel({ prompts: { learn: '我的写法' } }));
    const restore = learnBox().closest('article')?.querySelector('.secondary') as HTMLButtonElement;
    fireEvent.click(restore);
    expect(learnBox().value).toBe(LEARN_DEFAULT_POLICY);
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual({ type: 'saveSettings', patch: { prompts: { learn: '' } } });
  });

  it('三块都有现成方法可换，每套都有效果示例', () => {
    for (const target of ['guide', 'answer', 'learn'] as const) {
      const methods = BUILTIN_SKILLS.filter((skill) => skill.target === target);
      expect(methods.length).toBeGreaterThanOrEqual(3);
      for (const skill of methods) expect(skill.example?.length ?? 0).toBeGreaterThan(10);
    }
  });
});

describe('设置 - 阅读', () => {
  it('不再有「一轮几题」这种配额设置：伴随式对话聊到哪里由用户决定', () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    render(<Settings state={panel()} send={send} notice={null} onDismissNotice={() => {}} />);
    expect(screen.queryByText(/一轮几题/)).toBeNull();
    expect(screen.queryByText(/一轮最多问/)).toBeNull();
  });
});
