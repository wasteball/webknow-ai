import { describe, expect, it } from 'vitest';
import {
  AnswerResultSchema,
  BackgroundRequestSchema,
  EvidenceBlockSchema,
  PageRequestSchema,
  QuestionCommandSchema,
} from '../src/contracts';

const block = {
  id: 'b_1',
  sessionId: 's_1',
  modality: 'text',
  role: 'paragraph',
  content: '这是一个长度足够、可核查的原始证据段落。',
  context: { headingPath: ['研究结果'] },
  source: { url: 'https://example.test/article', title: '研究' },
  anchor: {
    sessionAnchorId: 's_1-0',
    selector: '#result > p',
    exact: '这是一个长度足够、可核查的原始证据段落。',
    prefix: '',
    suffix: '',
    textPosition: { start: 0, end: 21 },
    headingPath: ['研究结果'],
    fingerprint: 'abc',
  },
  provenance: { parser: 'readability', method: 'retained-anchor' },
  integrity: { fingerprint: 'abc', completeness: 'complete' },
  sourceLevel: 'L1',
};

const completeness = {
  scope: 'readability-article',
  text: { status: 'parsed', found: 1, captured: 1 },
  tables: { status: 'not-present', found: 0, captured: 0 },
  images: { status: 'not-present', found: 0, captured: 0 },
  excludedAmbiguousBlocks: 0,
  warnings: [],
};

describe('runtime contracts', () => {
  it('accepts a locally anchored evidence block', () => {
    expect(EvidenceBlockSchema.parse(block)).toEqual(block);
  });

  it('does not define model-supplied quote fields', () => {
    const result = AnswerResultSchema.parse({
      runId: 'r_1',
      sessionId: 's_1',
      question: '结论是什么？',
      status: 'SUPPORTED',
      conclusion: '结论',
      claims: [
        {
          id: 'c_1',
          statement: '结论',
          importance: 'key',
          status: 'supported',
          citations: [{ blockId: 'b_1', relation: 'supports' }],
        },
      ],
      evidence: [block],
      unanswered: [],
      coverage: { sentBlocks: 1, totalBlocks: 1 },
      completeness,
    });
    expect(result.evidence[0]?.content).toBe(block.content);
    expect(result.claims[0]).not.toHaveProperty('quote');
  });

  it('rejects unscoped page commands and key-bearing background messages', () => {
    expect(PageRequestSchema.safeParse({ type: 'CAPTURE', sessionId: 's_1' }).success).toBe(false);
    expect(
      BackgroundRequestSchema.safeParse({
        scope: 'wka-background',
        type: 'TEST_MODEL',
        apiKey: 'must-not-cross-message-boundary',
      }).success,
    ).toBe(false);
  });
  it('rejects evidence whose display content differs from its anchor', () => {
    expect(
      EvidenceBlockSchema.safeParse({
        ...block,
        content: '被替换的显示摘录',
      }).success,
    ).toBe(false);
  });

  it('rejects supported answers whose citations have no local evidence', () => {
    const parsed = AnswerResultSchema.safeParse({
      runId: 'r_2',
      sessionId: 's_1',
      question: '结论是什么？',
      status: 'SUPPORTED',
      conclusion: '结论',
      claims: [
        {
          id: 'c_2',
          statement: '结论',
          importance: 'key',
          status: 'supported',
          citations: [{ blockId: 'missing', relation: 'supports' }],
        },
      ],
      evidence: [],
      unanswered: [],
      coverage: { sentBlocks: 1, totalBlocks: 1 },
      completeness,
    });
    expect(parsed.success).toBe(false);
  });
  it('requires question commands to bind the current document session', () => {
    const base = { type: 'ASK', runId: 'r-1', tabId: 1, question: '问题' };
    expect(QuestionCommandSchema.safeParse(base).success).toBe(false);
    expect(QuestionCommandSchema.safeParse({ ...base, sessionId: 's-1' }).success).toBe(true);
  });
});
