import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { DocumentSession } from '../src/contracts';
import { modelApprovalState, modelCredentials } from '../src/model-secret';
import {
  clearModelConfig,
  clearSession,
  confirmRecipient,
  getSession,
  markSessionStale,
  modelStatus,
  saveModelCapability,
  saveModelConfig,
  saveSession,
} from '../src/storage';

const completeness = {
  scope: 'readability-article' as const,
  text: { status: 'parsed' as const, found: 0, captured: 0 },
  tables: { status: 'not-present' as const, found: 0, captured: 0 },
  images: { status: 'not-present' as const, found: 0, captured: 0 },
  excludedAmbiguousBlocks: 0,
  warnings: [],
};

function session(tabId: number): DocumentSession {
  return {
    id: `s-${tabId}`,
    tabId,
    state: 'IDLE',
    page: {
      tabId,
      url: `https://example.test/${tabId}`,
      origin: 'https://example.test',
      title: '测试',
      kind: 'html',
    },
    fingerprint: 'fingerprint',
    blocks: [],
    completeness,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('storage isolation', () => {
  beforeEach(() => fakeBrowser.reset());

  it('isolates sessions by tab and clears only the requested tab', async () => {
    await saveSession(session(1));
    await saveSession(session(2));
    await clearSession(1);
    expect(await getSession(1)).toBeUndefined();
    expect((await getSession(2))?.id).toBe('s-2');
  });

  it('never exposes the API key through public model status', async () => {
    await saveModelConfig('deepseek-chat', 'secret-key-for-test');
    const status = await modelStatus();
    expect(JSON.stringify(status)).not.toContain('secret-key-for-test');
    expect((await modelCredentials())?.apiKey).toBe('secret-key-for-test');
  });

  it('invalidates recipient confirmation after configuration changes', async () => {
    await saveModelConfig('deepseek-chat', 'first-secret');
    await confirmRecipient();
    expect((await modelStatus()).recipientConfirmed).toBe(true);
    await saveModelConfig('deepseek-reasoner', 'second-secret');
    expect((await modelStatus()).recipientConfirmed).toBe(false);
  });

  it('clears credentials without deleting page sessions', async () => {
    await saveModelConfig('deepseek-chat', 'secret-key-for-test');
    await saveSession(session(8));
    await clearModelConfig();
    expect(await modelCredentials()).toBeUndefined();
    expect((await getSession(8))?.id).toBe('s-8');
  });
  it('approves only a tested and confirmed current config', async () => {
    await saveModelConfig('deepseek-chat', 'secret-key-for-test');
    const credentials = await modelCredentials();
    if (!credentials) throw new Error('Missing test credentials');
    expect(await modelApprovalState()).toMatchObject({ tested: false, confirmed: false });
    await saveModelCapability(
      {
        testedAt: 1,
        model: 'deepseek-chat',
        directConnection: true,
        jsonMode: true,
        status: 'passed',
        detail: '测试通过',
      },
      credentials.configId,
    );
    expect(await modelApprovalState()).toMatchObject({ tested: true, confirmed: false });
    await confirmRecipient();
    expect(await modelApprovalState()).toMatchObject({ tested: true, confirmed: true });
    await saveModelConfig('deepseek-reasoner', 'replacement-secret');
    expect(await modelApprovalState()).toMatchObject({ tested: false, confirmed: false });
  });
  it('does not let an old run mark a replacement session stale', async () => {
    await saveSession(session(5));
    const replacement = { ...session(5), id: 'replacement-session' };
    await saveSession(replacement);
    await markSessionStale(5, 's-5');
    expect(await getSession(5)).toMatchObject({
      id: 'replacement-session',
      state: 'IDLE',
    });
  });
  it('discards a stored answer when its page session becomes stale', async () => {
    const evidence = {
      id: 'block-6',
      sessionId: 's-6',
      modality: 'text' as const,
      role: 'paragraph' as const,
      content: '合法的已保存证据。',
      context: { headingPath: [] },
      source: { url: 'https://example.test/6', title: '测试' },
      anchor: {
        sessionAnchorId: 'anchor-6',
        exact: '合法的已保存证据。',
        prefix: '',
        suffix: '',
        textPosition: { start: 0, end: 9 },
        headingPath: [],
        fingerprint: 'block-fingerprint',
      },
      provenance: { parser: 'readability' as const, method: 'retained-anchor' as const },
      integrity: { fingerprint: 'block-fingerprint', completeness: 'complete' as const },
      sourceLevel: 'L1' as const,
    };
    const stored = {
      ...session(6),
      state: 'READY_COMPLETE' as const,
      blocks: [evidence],
      completeness: {
        ...completeness,
        text: { status: 'parsed' as const, found: 1, captured: 1 },
      },
      latestAnswer: {
        runId: 'run-6',
        sessionId: 's-6',
        question: '问题',
        status: 'INSUFFICIENT' as const,
        conclusion: '当前资料不足以支持明确结论。',
        claims: [],
        evidence: [],
        unanswered: [],
        coverage: { sentBlocks: 0, totalBlocks: 1 },
        completeness: {
          ...completeness,
          text: { status: 'parsed' as const, found: 1, captured: 1 },
        },
      },
    };
    await saveSession(stored);
    await markSessionStale(6, 's-6');
    expect(await getSession(6)).toMatchObject({ id: 's-6', state: 'STALE' });
    expect((await getSession(6))?.latestAnswer).toBeUndefined();
  });
});
