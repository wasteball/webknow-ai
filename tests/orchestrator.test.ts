import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSession, EvidenceBlock } from '../src/contracts';
import { ModelRequestError } from '../src/model';
import { MAX_CONTEXT_CHARS, runQuestion } from '../src/orchestrator';

const mocks = vi.hoisted(() => ({
  chatJson: vi.fn(),
  approved: vi.fn(),
}));

vi.mock('../src/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/model')>();
  return {
    ...original,
    approvedModelCredentials: mocks.approved,
    chatJson: mocks.chatJson,
  };
});

function block(
  id: string,
  content = `原始证据 ${id}：样本结果支持该主张，但适用范围有限。`,
): EvidenceBlock {
  return {
    id,
    sessionId: 'session-1',
    modality: 'text',
    role: 'paragraph',
    content,
    context: { headingPath: ['结果'] },
    source: { url: 'https://example.test/article', title: '合成研究' },
    anchor: {
      sessionAnchorId: `anchor-${id}`,
      selector: `#${id}`,
      exact: content,
      prefix: '',
      suffix: '',
      textPosition: { start: 0, end: content.length },
      headingPath: ['结果'],
      fingerprint: `fp-${id}`,
    },
    provenance: { parser: 'readability', method: 'retained-anchor' },
    integrity: { fingerprint: `fp-${id}`, completeness: 'complete' },
    sourceLevel: 'L1',
  };
}

function session(blocks = [block('b-1'), block('b-2')]): DocumentSession {
  return {
    id: 'session-1',
    tabId: 1,
    state: 'READY_COMPLETE',
    page: {
      tabId: 1,
      url: 'https://example.test/article',
      origin: 'https://example.test',
      title: '合成研究',
      kind: 'html',
    },
    fingerprint: 'document-fingerprint',
    blocks,
    completeness: {
      scope: 'readability-article',
      text: { status: 'parsed', found: blocks.length, captured: blocks.length },
      tables: { status: 'not-present', found: 0, captured: 0 },
      images: { status: 'not-present', found: 0, captured: 0 },
      excludedAmbiguousBlocks: 0,
      warnings: [],
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function draft(citations: Array<{ blockId: string; relation: string }>) {
  return {
    claims: [
      {
        id: 'claim-1',
        statement: '方案能够减少处理时间。',
        importance: 'key',
        citations,
        quote: '模型伪造的摘录',
      },
    ],
    unanswered: [],
  };
}

describe('evidence orchestration', () => {
  beforeEach(() => {
    mocks.chatJson.mockReset();
    mocks.approved.mockReset().mockResolvedValue({
      configId: 'config-1',
      model: 'deepseek-chat',
      apiKey: 'test-secret',
    });
  });

  it('removes nonexistent IDs before verification and never uses model quotes', async () => {
    mocks.chatJson
      .mockResolvedValueOnce(
        draft([
          { blockId: 'missing', relation: 'supports' },
          { blockId: 'b-1', relation: 'supports' },
        ]),
      )
      .mockResolvedValueOnce({
        verdicts: [{ claimId: 'claim-1', citations: [{ blockId: 'b-1', relation: 'supports' }] }],
      });

    const result = await runQuestion(
      'run-1',
      session(),
      '方案有效吗？',
      new AbortController().signal,
      vi.fn(),
    );

    expect(result.status).toBe('SUPPORTED');
    expect(result.claims[0]?.citations).toEqual([{ blockId: 'b-1', relation: 'supports' }]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.content).toBe(block('b-1').content);
    expect(JSON.stringify(result)).not.toContain('模型伪造的摘录');
    const verificationPrompt = mocks.chatJson.mock.calls[1]?.[0].messages[1].content as string;
    expect(verificationPrompt).not.toContain('missing');
    const firstCredentials = mocks.chatJson.mock.calls[0]?.[0].credentials;
    expect(firstCredentials).toBe(mocks.chatJson.mock.calls[1]?.[0].credentials);
  });

  it('drops a citation when the verifier finds a different relation', async () => {
    mocks.chatJson
      .mockResolvedValueOnce(draft([{ blockId: 'b-1', relation: 'supports' }]))
      .mockResolvedValueOnce({
        verdicts: [{ claimId: 'claim-1', citations: [{ blockId: 'b-1', relation: 'limits' }] }],
      });

    const result = await runQuestion(
      'run-2',
      session(),
      '方案有效吗？',
      new AbortController().signal,
      vi.fn(),
    );

    expect(result.status).toBe('INSUFFICIENT');
    expect(result.conclusion).toBe('当前资料不足以支持明确结论。');
    expect(result.claims[0]?.status).toBe('insufficient');
    expect(result.evidence).toEqual([]);
  });

  it('marks independently verified support and opposition as conflicted', async () => {
    mocks.chatJson
      .mockResolvedValueOnce(
        draft([
          { blockId: 'b-1', relation: 'supports' },
          { blockId: 'b-2', relation: 'opposes' },
        ]),
      )
      .mockResolvedValueOnce({
        verdicts: [
          {
            claimId: 'claim-1',
            citations: [
              { blockId: 'b-1', relation: 'supports' },
              { blockId: 'b-2', relation: 'opposes' },
            ],
          },
        ],
      });

    const result = await runQuestion(
      'run-3',
      session(),
      '证据一致吗？',
      new AbortController().signal,
      vi.fn(),
    );
    expect(result.status).toBe('CONFLICTED');
    expect(result.claims[0]?.status).toBe('conflicted');
  });

  it('blocks oversized content before any model request instead of truncating', async () => {
    const oversized = block('large', '证'.repeat(MAX_CONTEXT_CHARS + 1));
    await expect(
      runQuestion('run-4', session([oversized]), '总结全文', new AbortController().signal, vi.fn()),
    ).rejects.toMatchObject({ detail: { code: 'CONTENT_TOO_LARGE' } });
    expect(mocks.chatJson).not.toHaveBeenCalled();
  });

  it('blocks transmission until the recipient is confirmed', async () => {
    mocks.approved.mockRejectedValue(
      new ModelRequestError({
        code: 'PERMISSION_REQUIRED',
        retryable: false,
        message: '需要确认接收方',
      }),
    );
    await expect(
      runQuestion('run-5', session(), '总结全文', new AbortController().signal, vi.fn()),
    ).rejects.toMatchObject({ detail: { code: 'PERMISSION_REQUIRED' } });
    expect(mocks.chatJson).not.toHaveBeenCalled();
  });
  it('refuses visual questions locally when images are unavailable', async () => {
    const visualSession = session();
    const completeness = visualSession.completeness;
    if (!completeness) throw new Error('Missing completeness fixture');
    visualSession.completeness = {
      ...completeness,
      images: { status: 'unavailable', found: 1, captured: 0, note: '未解析图片' },
    };
    const result = await runQuestion(
      'run-visual',
      visualSession,
      '图表中最高的柱子是什么？',
      new AbortController().signal,
      vi.fn(),
    );
    expect(result.status).toBe('INSUFFICIENT');
    expect(result.coverage.sentBlocks).toBe(0);
    expect(mocks.chatJson).not.toHaveBeenCalled();
  });

  it('blocks blocks that belong to another document session', async () => {
    const foreign = block('foreign');
    foreign.sessionId = 'another-session';
    await expect(
      runQuestion(
        'run-foreign',
        session([foreign]),
        '总结全文',
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ detail: { code: 'PARSE_FAILED' } });
    expect(mocks.chatJson).not.toHaveBeenCalled();
  });
});
