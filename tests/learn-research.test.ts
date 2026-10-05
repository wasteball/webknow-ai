import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCheckpoint, AgentOutcome } from '../src/core/search/agent-types';
import type { PageSession } from '../src/core/session';

const mocks = vi.hoisted(() => {
  let session: PageSession | null = null;
  return {
    get: vi.fn(async () => session ? structuredClone(session) : null),
    put: vi.fn(async (next: PageSession) => { session = structuredClone(next); }),
    seed: (next: PageSession) => { session = structuredClone(next); },
    callModel: vi.fn(), executeResearch: vi.fn(), assertResearchCurrent: vi.fn(async () => {}),
  };
});
vi.mock('wxt/browser', () => ({ browser: { i18n: { getUILanguage: () => 'zh-CN' } } }));
vi.mock('../src/background/store', () => ({
  getSession: mocks.get, putSession: mocks.put,
  readConfig: vi.fn(async () => ({
    provider: 'deepseek', apiKeys: { deepseek: 'fixture-key' }, search: { providerId: 'firecrawl' },
  })),
}));
vi.mock('../src/background/model', () => ({ callModel: mocks.callModel, assertOutboundConfirmation: vi.fn() }));
vi.mock('../src/background/page', () => ({
  readPageIdentity: vi.fn(async () => ({ url: 'https://example.org/article', fingerprint: 'fp' })),
  toAppError: (error: unknown) => error,
}));
vi.mock('../src/background/research', () => ({
  executeResearch: mocks.executeResearch, assertResearchCurrent: mocks.assertResearchCurrent,
  researchModelSelection: () => ({ modelProvider: 'deepseek', modelId: 'deepseek-chat' }),
  permissionOrigins: () => [],
}));

import { emptySession } from '../src/core/session';
import { appError } from '../src/core/errors';
import { abortRun, handleIntent } from '../src/background/runner';
import { snapshotFixture } from './helpers/research';

const question = '今天上海的政策是什么？';
const target = { blockIds: ['b_0'], focus: '文章主张的适用条件' };
const hooks = { onState: vi.fn(), onProgress: vi.fn() };
const response = {
  action: 'feedback', verdict: 'partial', feedback: '已说出主要条件。',
  nextQuestion: '文中如何限定适用范围？', nextQuestionTarget: target,
};

function learningSession(kind: 'open' | 'quiz' = 'open'): PageSession {
  return {
    ...emptySession(7, 'https://example.org/article'),
    state: 'LEARNING', fingerprint: 'fp', blocks: snapshotFixture().blocks,
    guide: { summary: '正文导览', bubbles: [] },
    learning: {
      goal: '理解这篇文章的核心内容', used: 1, status: 'active', promptVersion: 'fixture',
      current: kind === 'open'
        ? { kind: 'open', question, hintUsed: false, target }
        : {
            kind: 'quiz', questions: [{ id: 'q1', text: question, multi: false,
              choices: [{ id: 'A', label: '文中条件' }, { id: 'B', label: '所有情况' }], target }],
            answerKey: [{ questionId: 'q1', answer: ['A'], why: '文中给出了条件。' }],
          },
      log: [{ role: 'question', text: question, target, at: 1 }],
    },
  };
}

function researchResult(checkpoint: AgentCheckpoint): AgentOutcome {
  const source = {
    sourceId: `sr_${checkpoint.snapshot.identity.runId}_1`, title: '官方说明', url: 'https://example.org/policy', domain: 'example.org',
    snippet: '政策适用说明。', provider: 'fixture', attempts: [1], publishedAt: null,
    retrievedAt: '2026-10-05T00:00:00Z', readStatus: 'read' as const,
    decision: 'accepted' as const, dateStatus: 'date_unknown' as const, warnings: [],
  };
  return {
    kind: 'finished', degraded: false,
    checkpoint: { ...checkpoint, ledger: { ...checkpoint.ledger, sources: [source] } },
    answer: {
      type: 'finish_answer', answer: '根据网络资料，可确认该条件。', source: 'extended',
      citations: [], references: [source.sourceId], unanswered: [], freshness: 'verified',
    },
  };
}

function payload() {
  return JSON.parse(mocks.callModel.mock.calls[0]![0][1].content.split('\n')[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.seed(learningSession());
  mocks.callModel.mockReset().mockResolvedValue(response);
  mocks.executeResearch.mockReset().mockImplementation(async (checkpoint: AgentCheckpoint) => researchResult(checkpoint));
  mocks.assertResearchCurrent.mockReset().mockResolvedValue(undefined);
});

describe('learning research material ownership', () => {
  it('researches the current question instead of the user answer and persists real provenance without a model echo', async () => {
    expect(await handleIntent({ kind: 'learnAnswer', tabId: 7, text: '我觉得是 A', search: true }, hooks)).toBeNull();
    expect(mocks.executeResearch).toHaveBeenCalledOnce();
    expect(mocks.executeResearch.mock.calls[0]![0].snapshot.question).toBe(question);
    const entries = (await mocks.get())!.learning!.log;
    const material = entries.find(entry => entry.supplement?.source === 'network')!.supplement!;
    expect(material.references?.[0]).toMatchObject({
      sourceId: `sr_${mocks.executeResearch.mock.calls[0]![0].snapshot.identity.runId}_1`, url: 'https://example.org/policy',
    });
    expect(material.research?.sources[0]?.decision).toBe('accepted');
    expect(entries.filter(entry => entry.supplement?.source === 'network')).toHaveLength(1);
    expect(payload().supplementalContext.source).toBe('network');
  });

  it('uses the quiz question, not the generic goal, and retains program grading', async () => {
    mocks.seed(learningSession('quiz'));
    mocks.callModel.mockResolvedValue({
      action: 'graded', analysis: '反馈', notes: [], nextQuestion: response.nextQuestion,
      nextQuestionTarget: target, nextQuiz: null,
    });
    expect(await handleIntent({ kind: 'learnAnswer', tabId: 7, text: '（选择题作答）',
      choices: [{ questionId: 'q1', choiceIds: ['A'] }], search: true }, hooks)).toBeNull();
    expect(mocks.executeResearch.mock.calls[0]![0].snapshot.question).toBe(question);
    const feedback = (await mocks.get())!.learning!.log.find(entry => entry.role === 'feedback');
    expect(feedback?.graded?.[0]?.correct).toBe(true);
    expect(feedback?.mastery).not.toBe('independent');
  });

  it('does not search when off and records the missing verification even if the model omits it', async () => {
    expect(await handleIntent({ kind: 'learnAnswer', tabId: 7, text: '我的理解' }, hooks)).toBeNull();
    expect(mocks.executeResearch).not.toHaveBeenCalled();
    expect((await mocks.get())!.learning!.log.some(entry => entry.supplement?.source === 'unverified')).toBe(true);
  });

  it('keeps a research clarification as unverified without creating a waiting learning run', async () => {
    mocks.callModel.mockResolvedValue({ action: 'explain', explanation: '回到文章中的条件。', nextQuestion: response.nextQuestion });
    mocks.executeResearch.mockImplementation(async (checkpoint: AgentCheckpoint) => ({
      kind: 'waiting', checkpoint, question: { type: 'ask_user', question: '哪个政策？', reason: 'ambiguous_entity' },
    }));
    expect(await handleIntent({ kind: 'learnAssist', tabId: 7, assist: 'explain', search: true }, hooks)).toBeNull();
    const stored = (await mocks.get())!;
    expect(stored.run).toBeNull();
    expect(stored.researchCheckpoint).toBeUndefined();
    expect(stored.learning!.log.some(entry => entry.supplement?.source === 'unverified')).toBe(true);
  });

  it.each(['STALE_PAGE', 'PERMISSION_MISSING', 'OUTBOUND_CONFIRMATION_REQUIRED'] as const)(
    'does not continue learning after research invalidates %s', async code => {
      mocks.executeResearch.mockRejectedValue(appError(code, '该研究已失效。'));
      expect(await handleIntent({ kind: 'learnAnswer', tabId: 7, text: '我的理解', search: true }, hooks)).toMatchObject({ code });
      expect(mocks.callModel).not.toHaveBeenCalled();
    },
  );

  it('does not call the learning model after a stop during research', async () => {
    mocks.executeResearch.mockImplementation((_checkpoint, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(appError('ABORTED', '已停止。')));
    }));
    const running = handleIntent({ kind: 'learnAnswer', tabId: 7, text: '我的理解', search: true }, hooks);
    await vi.waitFor(() => expect(mocks.executeResearch).toHaveBeenCalledOnce());
    expect(abortRun(7)).toBe(true);
    expect(await running).toMatchObject({ code: 'ABORTED' });
    expect(mocks.callModel).not.toHaveBeenCalled();
  });

  it('closes without starting a new research call', async () => {
    mocks.callModel.mockResolvedValue({ action: 'summary', summary: '只说明本轮已验证的范围。', nextDirections: [] });
    expect(await handleIntent({ kind: 'learnEnd', tabId: 7 }, hooks)).toBeNull();
    expect(mocks.executeResearch).not.toHaveBeenCalled();
  });
});
