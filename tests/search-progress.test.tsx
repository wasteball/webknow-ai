// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentPhase, ResearchSummary } from '../src/core/search/agent-types';
import type { PanelState } from '../src/core/protocol';
import { SearchProgress } from '../src/sidepanel/components/SearchProgress';
import { SearchSources } from '../src/sidepanel/components/SearchSources';
import { Reading } from '../src/sidepanel/components/Reading';
import { panel } from './helpers/panel';
import { snapshotFixture } from './helpers/research';

const permissions = vi.hoisted(() => ({ request: vi.fn(async () => true) }));
vi.mock('wxt/browser', () => ({ browser: { permissions } }));
const identity = snapshotFixture().identity;
const event = { identity, seq: 2, phase: 'searching' as const, searches: 2, reads: 0, reason: 'retry' as const };
const research: ResearchSummary = {
  attempts: [{ id: 1, action: { type: 'search_web', query: '版本更新', purpose: 'latest', freshness: 'live', language: 'zh', domains: [], maxResults: 5 },
    queryKey: 'q', strategyKey: 's', status: 'ok', reason: 'initial', sourceIds: ['s1', 's2'], retrievedAt: '2026-10-01T08:00:00Z' }],
  sources: ['s1', 's2'].map((sourceId, index) => ({ sourceId, title: index ? '旧公告' : '官方更新', url: `https://example.org/${sourceId}`, domain: 'example.org', snippet: '', provider: 'test', attempts: [1], publishedAt: index ? null : '2026-10-01', retrievedAt: '2026-10-02T08:00:00Z', readStatus: index ? 'unavailable' : 'read', decision: index ? 'rejected' : 'accepted', reason: index ? '内容过旧' : undefined, dateStatus: index ? 'date_unknown' : 'fresh', warnings: [] })),
  conflicts: [{ sourceIds: ['s1', 's2'], description: '版本号冲突' }], freshness: 'verified', degraded: false,
};
function researching(phase: AgentPhase = 'waiting', over: Partial<PanelState> = {}): PanelState {
  const base = panel();
  return panel({ sessionId: 's1', pageUrl: identity.url,
    settings: { ...base.settings, search: { ...base.settings.search, enabled: true, agent: { ...base.settings.search.agent, enabled: true } } },
    researchPending: { runId: 'r1', question: '最新版本是什么？', quote: null, status: phase === 'waiting' ? 'waiting' : 'running', clarification: { type: 'ask_user', question: '哪个产品？', reason: 'ambiguous_entity' } },
    busy: { kind: 'answer', agent: { ...event, phase }, chars: 15, draft: '{"type":"finish_answer"}', reasoning: '秘密推理' }, ...over });
}

it('announces actual actions without exposing reasoning', () => {
  render(<SearchProgress event={event} />);
  expect(screen.getByRole('status').textContent).toContain('第 2 次');
  expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  expect(screen.queryByText('思考过程')).toBeNull();
});

it('keeps query/source details collapsed with distinct publication, retrieval, reading and decisions', () => {
  render(<SearchSources references={[]} research={research} />);
  const summary = screen.getByText('本轮搜索详情');
  const details = summary.closest('details')!;
  expect(details.open).toBe(false);
  summary.focus();
  expect(document.activeElement).toBe(summary);
  fireEvent.click(summary, { detail: 0 });
  expect(details.open).toBe(true);
  expect(screen.getByText('已采用来源')).toBeTruthy();
  expect(screen.getByText('未采用来源')).toBeTruthy();
  expect(screen.getByText(/日期未知/)).toBeTruthy();
  expect(screen.getByText(/发布时间：2026-10-01/)).toBeTruthy();
  expect(screen.getByText(/内容过旧/)).toBeTruthy();
  expect(screen.getByText('版本号冲突')).toBeTruthy();
  expect(screen.getByRole('link', { name: '官方更新' }).getAttribute('href')).toBe('https://example.org/s1');
  expect(screen.getByRole('link', { name: '官方更新' }).getAttribute('rel')).toBe('noreferrer');
});

it('never links an unsafe source URL', () => {
  render(<SearchSources references={[{ sourceId: 'bad', title: '坏链接', url: 'javascript:alert(1)', domain: '', publishedAt: null, retrievedAt: '', readStatus: 'not_read' }]} />);
  expect(screen.queryByRole('link')).toBeNull();
});

describe('research composer', () => {
  it.each<AgentPhase>(['deciding', 'searching', 'reading', 'checking', 'answering', 'waiting', 'degraded'])('%s keeps stop in the composer and hides unreviewed output', async (phase) => {
    const send = vi.fn(async () => ({ ok: true as const }));
    render(<Reading state={researching(phase)} send={send} />);
    const stop = screen.getByRole('button', { name: '停止' });
    expect(document.querySelector('.composer-field')?.contains(stop)).toBe(true);
    expect(screen.queryByText(/finish_answer/)).toBeNull();
    expect(screen.queryByText('秘密推理')).toBeNull();
    fireEvent.click(stop);
    expect(send).toHaveBeenCalledWith({ type: 'stop', tabId: 7 });
    await act(async () => {});
  });

  it.each(['continue', 'article', 'cancel'] as const)('sends guarded %s without the unrelated composer draft', async (mode) => {
    const send = vi.fn(async () => ({ ok: true as const }));
    render(<Reading state={researching()} send={send} />);
    const composer = screen.getByLabelText('向这篇文章提问') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: '下一题草稿' } });
    const answer = screen.getByLabelText('补充条件') as HTMLTextAreaElement;
    expect(answer.maxLength).toBe(500);
    fireEvent.change(answer, { target: { value: '产品 A' } });
    fireEvent.click(screen.getByRole('button', { name: mode === 'continue' ? '继续' : mode === 'article' ? '只按文章' : '取消' }));
    await act(async () => {});
    expect(send).toHaveBeenCalledWith({ type: 'resolveResearch', tabId: 7, sessionId: 's1', runId: 'r1', mode, text: mode === 'continue' ? '产品 A' : mode === 'article' ? '只依据文章回答，不使用网络资料。' : '' });
    expect(composer.value).toBe('下一题草稿');
  });

  it.each(['stopped', 'interrupted'] as const)('%s preserves original question and requires an explicit fresh ask', async (status) => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const state = researching();
    render(<Reading state={{ ...state, busy: null, researchPending: { ...state.researchPending!, status } }} send={send} />);
    expect(screen.getByText('最新版本是什么？')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新研究这个问题' }));
    await act(async () => {});
    expect(send).toHaveBeenCalledWith({ type: 'ask', tabId: 7, question: '最新版本是什么？', network: 'auto', quote: null });
  });

  it('uses backend permission origins only after the click and requires grant before continuing', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const state = researching();
    state.settings.search.sourceCapabilities.directRead = true;
    state.researchPending = { ...state.researchPending!, clarification: { type: 'ask_user', question: '是否允许读取？', reason: 'permission' }, permissionOrigins: ['https://verified.org/*'] };
    permissions.request.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<Reading state={state} send={send} />);
    expect(screen.getByText('https://verified.org/*')).toBeTruthy();
    expect(permissions.request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('补充条件'), { target: { value: '允许' } });
    fireEvent.click(screen.getByRole('button', { name: '授权并继续' }));
    await act(async () => {});
    expect(permissions.request).toHaveBeenCalledWith({ origins: ['https://verified.org/*'] });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '授权并继续' }));
    await act(async () => {});
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resolveResearch', mode: 'continue', runId: 'r1' }));
  });

  it('cannot grant an unverified reader capability', () => {
    const state = researching();
    render(<Reading state={{ ...state, researchPending: { ...state.researchPending!, clarification: { type: 'ask_user', question: '读取来源？', reason: 'permission' }, permissionOrigins: ['https://verified.org/*'] } }} send={vi.fn()} />);
    expect((screen.getByRole('button', { name: '授权并继续' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('直接读取尚未验证')).toBeTruthy();
  });

  it('exposes three per-question modes, keeps quote identity, and discloses disabled live verification', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const settings = vi.fn();
    render(<Reading state={panel({ quote: { id: 'q2', text: '新划词', blockId: 'b2' } })} send={send} onSearchSettings={settings} />);
    const input = screen.getByLabelText('向这篇文章提问');
    fireEvent.change(input, { target: { value: '产品 A 最新版本是什么？' } });
    const mode = screen.getByLabelText('本题联网方式');
    expect(screen.getByRole('option', { name: '智能联网' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '本题联网' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '只依据文章' })).toBeTruthy();
    fireEvent.change(mode, { target: { value: 'force' } });
    expect(screen.getByText(/联网总开关已关闭.*未核验/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '联网设置' }));
    expect(settings).toHaveBeenCalledOnce();
    fireEvent.submit(input.closest('form')!);
    await act(async () => {});
    expect(send).toHaveBeenCalledWith({ type: 'ask', tabId: 7, question: '产品 A 最新版本是什么？', network: 'force', quote: '新划词', quoteId: 'q2' });
  });
});

it('a permission result cannot resume a card that stopped while the browser prompt was open', async () => {
  let grant!: (allowed: boolean) => void;
  permissions.request.mockImplementationOnce(() => new Promise<boolean>(resolve => { grant = resolve; }));
  const send = vi.fn(async () => ({ ok: true as const }));
  const state = researching();
  state.settings.search.sourceCapabilities.directRead = true;
  state.researchPending = { ...state.researchPending!, clarification: { type: 'ask_user', question: '允许读取来源？', reason: 'permission' }, permissionOrigins: ['https://verified.org/*'] };
  const { rerender } = render(<Reading state={state} send={send} />);
  fireEvent.change(screen.getByLabelText('补充条件'), { target: { value: '允许' } });
  fireEvent.click(screen.getByRole('button', { name: '授权并继续' }));
  rerender(<Reading state={{ ...state, busy: null, researchPending: { ...state.researchPending!, status: 'interrupted' } }} send={send} />);
  await act(async () => grant(true));
  expect(send).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
});

it('bounds clarification text and does not consume a new selection on an explicit retry', async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  const state = researching();
  state.quote = { id: 'new', text: '后来划词', blockId: 'b2' };
  const { rerender } = render(<Reading state={state} send={send} />);
  fireEvent.change(screen.getByLabelText('补充条件'), { target: { value: 'a'.repeat(520) } });
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  await act(async () => {});
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resolveResearch', text: 'a'.repeat(500) }));
  rerender(<Reading state={{ ...state, busy: null, researchPending: { ...state.researchPending!, status: 'stopped', quote: { id: 'old', text: '上一轮划词', blockId: 'b1' } } }} send={send} />);
  const composer = screen.getByLabelText('向这篇文章提问') as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: '下一题草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '重新研究这个问题' }));
  await act(async () => {});
  expect(send).toHaveBeenCalledWith({ type: 'ask', tabId: 7, question: '最新版本是什么？', network: 'auto', quote: '上一轮划词', quoteId: 'old' });
  expect(document.querySelector('.composer .quote-chip')?.textContent).toContain('后来划词');
  expect(composer.value).toBe('下一题草稿');
});

it('keeps disabled live-verification disclosure and settings available after the question is sent', async () => {
  const state = panel();
  const send = vi.fn(async () => ({ ok: true as const }));
  const settings = vi.fn();
  const { rerender } = render(<Reading state={state} send={send} onSearchSettings={settings} />);
  const input = screen.getByLabelText('向这篇文章提问');
  fireEvent.change(input, { target: { value: '产品 A 最新版本是什么？' } });
  fireEvent.submit(input.closest('form')!);
  await act(async () => {});
  expect(screen.getByText(/联网总开关已关闭.*未核验/)).toBeTruthy();
  rerender(<Reading state={{ ...state, chat: [{ id: 't1', question: '产品 A 最新版本是什么？', answer: '原文无法确认。', source: 'unknown', citations: [], references: [], unanswered: ['缺少实时核验依据。'], at: 1 }] }} send={send} onSearchSettings={settings} />);
  fireEvent.click(screen.getByRole('button', { name: '联网设置' }));
  expect(settings).toHaveBeenCalledOnce();
});
