import { initialCheckpoint } from '../../src/core/search/agent-limits';
import type { AgentCheckpoint, AgentSnapshot, AgentDependencies } from '../../src/core/search/agent-types';
import { appError } from '../../src/core/errors';

export function scriptedDependencies(outputs: unknown[], options?: Partial<AgentDependencies>): AgentDependencies {
  let index = 0;
  return {
    callJson: async () => {
      if (index >= outputs.length) throw appError('BAD_OUTPUT', 'Script exhausted');
      return outputs[index++];
    },
    search: async () => ({ status: 'empty', results: [], provider: 'test', retrievedAt: '2026-10-01T08:00:00.000Z', warnings: [] }),
    read: async (ids) => ids.map(sourceId => ({ sourceId, text: '', publishedAt: null,
      retrievedAt: '2026-10-01T08:00:00.000Z', status: 'unavailable', warnings: [] })),
    assertCurrent: async () => {}, now: () => Date.parse('2026-10-01T08:00:00.000Z'), onEvent: () => {},
    ...options,
  };
}

export function snapshotFixture(overrides?: Partial<AgentSnapshot>): AgentSnapshot {
  return {
    identity: {
      tabId: 7, sessionId: 's1', runId: 'r1', fingerprint: 'fp',
      url: 'https://example.org/article', modelProvider: 'deepseek', modelId: 'deepseek-chat',
    },
    question: '最新版本是什么？', title: '三个团队的试点',
    blocks: [{
      id: 'b_0', role: 'paragraph', content: '试点只有三个团队。', headingPath: [],
      anchor: {
        sessionAnchorId: 'a0', selector: 'p', exact: '试点只有三个团队。',
        prefix: '', suffix: '', headingPath: [], fingerprint: 'fp',
      },
    }],
    quote: null, history: [], disclosure: '当前已提取正文',
    gate: {
      level: 'required', freshness: 'live', canSearch: true, mustSearch: true,
      time: { nowIso: '2026-10-01T08:00:00.000Z', localDate: '2026-10-01', timeZone: 'Asia/Shanghai' },
      reasons: [],
    },
    settings: {
      enabled: true, depth: 'deep', freshness: 'auto', language: 'zh-CN', region: 'CN',
      sourceReading: 'provider', preferredDomains: [], policy: '',
    },
    policyVersion: '2026-10-02.1', answerPolicy: '只依据允许的材料回答', diagrams: false,
    ...overrides,
  };
}

export function checkpointFixture(): AgentCheckpoint {
  return initialCheckpoint(snapshotFixture(), Date.parse('2026-10-01T08:00:00.000Z'));
}
