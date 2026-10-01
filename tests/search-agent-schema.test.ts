import { describe, expect, it } from 'vitest';
import { AgentActionSchema } from '../src/core/search/agent-schema';
import { initialCheckpoint } from '../src/core/search/agent-limits';
import type { AgentAction } from '../src/core/search/agent-types';
import { checkpointFixture, snapshotFixture } from './helpers/research';

const search = {
  type: 'search_web', query: '版本', purpose: 'latest', freshness: 'live',
  language: 'zh-CN', domains: [], maxResults: 5,
} satisfies AgentAction;
const read = { type: 'read_sources', sourceIds: ['sr_1'], focus: '版本' } satisfies AgentAction;
const ask = { type: 'ask_user', question: '哪个产品？', reason: 'ambiguous_entity' } satisfies AgentAction;
const finish = {
  type: 'finish_answer', answer: '试点只有三个团队。', source: 'original',
  citations: ['b_0'], references: [], unanswered: [], freshness: 'not_applicable',
} satisfies AgentAction;

it('rejects tool injection, raw URLs and model-selected permissions', () => {
  expect(AgentActionSchema.safeParse({
    type: 'read_sources', sourceIds: ['https://example.org/a'], focus: '版本',
  }).success).toBe(false);
  expect(AgentActionSchema.safeParse({
    type: 'search_web', query: '版本', purpose: 'latest', freshness: 'live',
    language: 'zh-CN', domains: [], maxResults: 5, apiKey: 'fixture-secret',
  }).success).toBe(false);
});

describe('bounded search actions', () => {
  it.each(['', ' ', 'x'.repeat(201), '版本\u0000', '版本\n', '版本\u007f', '版本\u0085'])('rejects invalid query %j', (query) => {
    expect(AgentActionSchema.safeParse({ ...search, query }).success).toBe(false);
  });

  it.each([
    'https://example.org', 'example.org/path', 'user@example.org', 'example.org:443',
    'example.org?x=1', 'example.org#fragment', 'bad..example.org', '-bad.example.org',
  ])('rejects non-host domain %j', (domain) => {
    expect(AgentActionSchema.safeParse({ ...search, domains: [domain] }).success).toBe(false);
  });

  it.each([0, 11, 1.5])('rejects invalid result count %j', (maxResults) => {
    expect(AgentActionSchema.safeParse({ ...search, maxResults }).success).toBe(false);
  });

  it('bounds language and domain counts', () => {
    expect(AgentActionSchema.safeParse({ ...search, language: 'x'.repeat(41) }).success).toBe(false);
    expect(AgentActionSchema.safeParse({ ...search, domains: Array(6).fill('example.org') }).success).toBe(false);
  });

  it('accepts search boundaries and pure hostnames', () => {
    expect(AgentActionSchema.safeParse({
      ...search, query: 'x'.repeat(200), language: 'x'.repeat(40),
      domains: ['example.org', 'news.example.org', 'xn--fiqs8s.example', 'a-b.org', 'example.com'], maxResults: 10,
    }).success).toBe(true);
    expect(AgentActionSchema.safeParse({ ...search, query: '版', maxResults: 1 }).success).toBe(true);
  });
});

describe('bounded source reading and clarification', () => {
  it('rejects six distinct read IDs', () => {
    expect(AgentActionSchema.safeParse({ ...read, sourceIds: ['sr_1', 'sr_2', 'sr_3', 'sr_4', 'sr_5', 'sr_6'] }).success).toBe(false);
  });

  it('deduplicates read IDs before enforcing the five-source limit', () => {
    expect(AgentActionSchema.parse({ ...read, sourceIds: ['sr_1', 'sr_2', 'sr_3', 'sr_4', 'sr_5', 'sr_1'] }))
      .toEqual({ ...read, sourceIds: ['sr_1', 'sr_2', 'sr_3', 'sr_4', 'sr_5'] });
  });

  it.each(['', 'sr_', 'b_0', 'sr_a/path', 'sr_a?x', 'sr_a b'])('rejects malformed source ID %j', (sourceId) => {
    expect(AgentActionSchema.safeParse({ ...read, sourceIds: [sourceId] }).success).toBe(false);
    expect(AgentActionSchema.safeParse({ ...finish, references: [sourceId] }).success).toBe(false);
  });

  it('rejects empty reads and invalid focus or questions', () => {
    expect(AgentActionSchema.safeParse({ ...read, sourceIds: [] }).success).toBe(false);
    for (const text of ['', ' ', 'x'.repeat(501)]) {
      expect(AgentActionSchema.safeParse({ ...read, focus: text }).success).toBe(false);
      expect(AgentActionSchema.safeParse({ ...ask, question: text }).success).toBe(false);
    }
    expect(AgentActionSchema.safeParse({ ...read, focus: 'x'.repeat(500) }).success).toBe(true);
    expect(AgentActionSchema.safeParse({ ...ask, question: 'x'.repeat(500) }).success).toBe(true);
  });
});

describe('strict action contract', () => {
  it.each([search, read, ask, finish])('accepts the legal $type action', (action) => {
    expect(AgentActionSchema.parse(action)).toEqual(action);
  });

  it.each([search, read, ask, finish])('rejects model-selected permissions on $type', (action) => {
    expect(AgentActionSchema.safeParse({ ...action, permissions: ['<all_urls>'] }).success).toBe(false);
  });

  it.each([
    { ...search, type: 'execute_script' }, { ...search, purpose: 'browse' },
    { ...search, freshness: 'year' }, { ...ask, reason: 'convenience' },
    { ...finish, source: 'supplement' }, { ...finish, freshness: 'fresh' },
  ])('rejects unknown action and enum values %j', (action) => {
    expect(AgentActionSchema.safeParse(action).success).toBe(false);
  });

  it('rejects oversized or blank answers while accepting multiline answers at the limit', () => {
    for (const answer of ['', ' ', 'x'.repeat(8_001)]) {
      expect(AgentActionSchema.safeParse({ ...finish, answer }).success).toBe(false);
    }
    expect(AgentActionSchema.safeParse({ ...finish, answer: `段落\n${'x'.repeat(7_997)}` }).success).toBe(true);
  });

  it('rejects raw URLs in finish references', () => {
    expect(AgentActionSchema.safeParse({ ...finish, references: ['https://example.org/a'] }).success).toBe(false);
  });

  it('bounds finish references after deduplication', () => {
    const references = ['sr_1', 'sr_2', 'sr_3', 'sr_4', 'sr_5'];
    expect(AgentActionSchema.parse({ ...finish, references: [...references, 'sr_1'] }))
      .toEqual({ ...finish, references });
    expect(AgentActionSchema.safeParse({ ...finish, references: [...references, 'sr_6'] }).success).toBe(false);
  });

  it('bounds reference and citation IDs and the existing 400-block citation ceiling', () => {
    for (const id of ['', 'x'.repeat(201), 'b_0\u0000']) {
      expect(AgentActionSchema.safeParse({ ...finish, citations: [id] }).success).toBe(false);
    }
    expect(AgentActionSchema.safeParse({ ...read, sourceIds: [`sr_${'x'.repeat(198)}`] }).success).toBe(false);
    expect(AgentActionSchema.safeParse({ ...finish, references: [`sr_${'x'.repeat(198)}`] }).success).toBe(false);
    expect(AgentActionSchema.safeParse({ ...finish, references: [`sr_${'x'.repeat(197)}`] }).success).toBe(true);
    expect(AgentActionSchema.safeParse({ ...finish, citations: ['b_bad/path'] }).success).toBe(false);
    expect(AgentActionSchema.safeParse({ ...finish, citations: Array.from({ length: 401 }, (_, i) => `b_${i}`) }).success).toBe(false);
    expect(AgentActionSchema.safeParse({ ...finish, citations: Array.from({ length: 400 }, (_, i) => `b_${i}`) }).success).toBe(true);
  });

  it('bounds unanswered aspects to 20 nonempty items of at most 500 characters', () => {
    for (const unanswered of [[''], [' '], ['x'.repeat(501)], Array(21).fill('未核验')]) {
      expect(AgentActionSchema.safeParse({ ...finish, unanswered }).success).toBe(false);
    }
    expect(AgentActionSchema.safeParse({ ...finish, unanswered: Array(20).fill('x'.repeat(500)) }).success).toBe(true);
  });
});

describe('initial research state', () => {
  it('starts an empty run with a deadline relative to the supplied time', () => {
    const snapshot = snapshotFixture();
    const checkpoint = initialCheckpoint(snapshot, 123_000);
    expect(checkpoint).toEqual({
      snapshot,
      ledger: { runId: 'r1', sources: [], attempts: [], assessment: null },
      actions: 0, audits: 0, formatRepairs: 0, readIds: [], noGainByStrategy: {},
      deadlineAt: 303_000, eventSeq: 0, feedback: [], waiting: null,
    });
  });

  it('uses deterministic defaults and independent fixture state', () => {
    const first = checkpointFixture();
    const second = checkpointFixture();
    expect(first.snapshot.identity).toEqual({
      tabId: 7, sessionId: 's1', runId: 'r1', fingerprint: 'fp',
      url: 'https://example.org/article', modelProvider: 'deepseek', modelId: 'deepseek-chat',
    });
    expect(first.snapshot.gate.time).toEqual({
      nowIso: '2026-10-01T08:00:00.000Z', localDate: '2026-10-01', timeZone: 'Asia/Shanghai',
    });
    expect(first.deadlineAt).toBe(1_790_841_780_000);
    first.snapshot.blocks[0]!.content = 'changed';
    first.ledger.sources.push({} as never);
    expect(second.snapshot.blocks[0]!.content).toBe('试点只有三个团队。');
    expect(second.ledger.sources).toEqual([]);
    expect(snapshotFixture({ question: '自定义问题' }).question).toBe('自定义问题');
  });
});
