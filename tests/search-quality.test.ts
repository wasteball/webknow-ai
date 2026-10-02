import { describe, expect, it, vi } from 'vitest';
// WXT's defineConfig is an identity wrapper; isolate it from the expensive build CLI import.
vi.mock('wxt', () => ({ defineConfig: <T>(config: T) => config }));
import cases from './fixtures/search-agent/quality-cases.json';
import { evaluateSearchGate } from '../src/core/search/gate';
import { initialCheckpoint } from '../src/core/search/agent-limits';
import { runResearch } from '../src/core/search/orchestrator';
import type { AgentAction, AuditResult, EvidenceAssessment, SearchBatch } from '../src/core/search/agent-types';
import { snapshotFixture, scriptedDependencies } from './helpers/research';

// Synthetic program-contract regression only. Expected claims/disclosures are manually authored
// fixed reference answers; scripted model/auditor responses are inputs, never quality scores.
describe('fixed reference quality cases (synthetic, not live semantic acceptance)', () => {
  it('keeps eight families with a positive and boundary case each', () => {
    expect(cases).toHaveLength(16);
    expect(new Set(cases.map(c => c.family)).size).toBe(8);
    for (const family of new Set(cases.map(c => c.family))) {
      expect(cases.filter(c => c.family === family).map(c => c.variant).sort()).toEqual(['boundary', 'positive']);
    }
  });
  it.each(cases)('$id: gate, supported claims and disclosure match fixed reference', async c => {
    const gate = evaluateSearchGate({ question: c.question, pageTitle: c.article.title, quote: null,
      enabled: c.enabled, mode: c.mode as 'auto' | 'force' | 'article', freshness: 'auto',
      now: new Date(c.now), timeZone: 'Asia/Shanghai' });
    expect({ level: gate.level, canSearch: gate.canSearch, mustSearch: gate.mustSearch }).toEqual(c.expectedGate);
    const snapshot = snapshotFixture({ question: c.question, title: c.article.title,
      blocks: [{ ...snapshotFixture().blocks[0]!, content: c.article.text }], gate });
    snapshot.settings.enabled = c.enabled;
    const searches: string[] = [];
    const script = c.script as (AgentAction | EvidenceAssessment | AuditResult)[];
    const deps = scriptedDependencies(script, { now: () => Date.parse(c.now), search: async action => {
      searches.push(action.query);
      return { status: c.evidence.length ? 'ok' : 'empty', results: c.evidence,
        provider: 'synthetic', retrievedAt: c.now, warnings: [] } as SearchBatch;
    } });
    const outcome = await runResearch({ checkpoint: initialCheckpoint(snapshot, Date.parse(c.now)), deps,
      signal: new AbortController().signal });
    expect(outcome.kind).toBe(c.expectedOutcome);
    if (outcome.kind === 'waiting') {
      expect(outcome.question.question).toContain(c.expectedDisclosure);
    } else {
      for (const claim of c.allowedClaims) expect(outcome.answer.answer).toContain(claim);
      for (const claim of c.forbiddenClaims) expect(outcome.answer.answer).not.toContain(claim);
      if (c.expectedDisclosure) expect(outcome.answer.answer).toContain(c.expectedDisclosure);
      expect(outcome.answer.freshness).toBe(c.expectedFreshness);
      expect(outcome.answer.references).toEqual(c.expectedReferences);
    }
    expect(searches).toHaveLength(c.expectedSearches);
  });
});

it('keeps exact test origins separate from production fixed permissions', async () => {
  const { default: config } = await import('../wxt.config');
  if (typeof config.manifest !== 'function') throw new Error('Expected mode-specific manifest');
  const production = await config.manifest({ mode: 'production' } as never);
  const e2e = await config.manifest({ mode: 'e2e' } as never);
  expect(production.host_permissions).toEqual(['https://api.deepseek.com/*']);
  expect(e2e.host_permissions).toEqual(['https://api.deepseek.com/*', 'https://open.bigmodel.cn/*',
    'http://127.0.0.1/*', 'https://api.bochaai.com/*', 'https://api.firecrawl.dev/*']);
  expect(production.permissions).toEqual(['storage', 'sidePanel', 'scripting', 'activeTab']);
  expect(e2e.permissions).toEqual(production.permissions);
});

it('rejects injected tools twice without transport or raw-output persistence', async () => {
  const searched: string[] = [];
  const deps = scriptedDependencies([{ type: 'send_key', key: 'sk-injected-secret' }, { type: 'send_key', key: 'sk-injected-secret' }],
    { search: async action => { searched.push(action.query); throw new Error('Unexpected search'); } });
  const snapshot = snapshotFixture();
  const result = await runResearch({ checkpoint: initialCheckpoint(snapshot, Date.parse(snapshot.gate.time.nowIso)),
    deps, signal: new AbortController().signal });
  expect(result).toMatchObject({ kind: 'finished', degraded: true, answer: { source: 'unknown', references: [] } });
  expect(searched).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('sk-injected-secret');
});
