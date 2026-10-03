import { outboundScope } from '../core/settings';
import { browser } from 'wxt/browser';
import { appError } from '../core/errors';
import { findProvider } from '../core/model-providers';
import { resolveThinking } from '../core/model-thinking';
import { assertActiveResearch } from './runner';
import type { AgentCheckpoint, AgentEvent, AgentResume, RunIdentity } from '../core/search/agent-types';
import { runResearch } from '../core/search/orchestrator';
import { findSearchProvider, researchSearch } from '../core/search/registry';
import { DIRECT_READ_VERIFIED, readSources } from '../core/search/source-reader';
import { publicSourceUrl } from '../core/search/source-url';
import { assertOutboundConfirmation, callResearchModel } from './model';
import { readPageIdentity } from './page';
import { getSession, readConfig, readSearchCredentials, type Config } from './store';

export function researchModelSelection(config: Config) {
  const provider = findProvider(config.provider);
  const modelId = config.models?.[provider.id]?.trim() || provider.defaultModel;
  return { modelProvider: provider.id, modelId,
    thinking: resolveThinking(modelId, config.thinking?.[provider.id]?.[modelId]) ?? undefined };
}

/** Authoritative run/page and receiver checks; never adopt new content during a research run. */
export async function assertResearchCurrent(identity: RunIdentity, thinking?: string, signal?: AbortSignal, searchProviderId?: string, frozenScope?: string): Promise<void> {
  const assertSignal = () => { if (signal?.aborted) throw appError('ABORTED', '已停止本次研究。'); };
  assertSignal();
  const live = await readPageIdentity(identity.tabId);
  const fresh = await getSession(identity.tabId);
  const config = await readConfig();
  const model = researchModelSelection(config);
  assertSignal();
  if (fresh?.id !== identity.sessionId || fresh.run?.id !== identity.runId ||
      fresh.url !== identity.url || fresh.fingerprint !== identity.fingerprint ||
      live?.url !== identity.url || live.fingerprint !== identity.fingerprint ||
      (searchProviderId !== undefined && config.search?.providerId !== searchProviderId) ||
      model.modelProvider !== identity.modelProvider || model.modelId !== identity.modelId || model.thinking !== thinking) {
    throw appError('STALE_PAGE', '页面或模型已经变化，请重新提问。');
  }
  if (frozenScope !== undefined && outboundScope(config) !== frozenScope) throw appError('STALE_PAGE', '外发接收方或范围已经变化，请重新提问。');
  assertOutboundConfirmation(config);
  assertActiveResearch(identity, fresh);
}

export function permissionOrigins(checkpoint: AgentCheckpoint): string[] {
  return [...new Set(checkpoint.ledger.sources.filter(source => source.warnings.includes('source_permission_missing'))
    .flatMap(source => { const url = publicSourceUrl(source.url); return url ? [`${url.origin}/*`] : []; }))];
}

export async function executeResearch(checkpoint: AgentCheckpoint, signal: AbortSignal,
  onEvent: (event: AgentEvent) => void, resume?: AgentResume) {
  const { identity, thinking } = checkpoint.snapshot;
  const searchReceiver = checkpoint.snapshot.searchProviderId;
  if (!searchReceiver) throw appError('STALE_PAGE', '这次研究缺少接收方身份，请重新提问。');
  const assertCurrent = () => assertResearchCurrent(identity, thinking, signal, searchReceiver, checkpoint.snapshot.outboundScope);
  // Private preparation values live only in this invocation, never in evidence or run identity.
  const assertSameCredentials = (prepared: Record<string, string>, current: Record<string, string>) => {
    if (Object.keys(prepared).length !== Object.keys(current).length ||
        Object.keys(prepared).some(key => prepared[key] !== current[key])) {
      throw appError('ABORTED', '搜索服务的配置已变化，请重新提问。');
    }
  };
  const assertAction = async (action: 'search' | 'read') => {
    const current = assertActiveResearch(identity, await getSession(identity.tabId));
    if (!checkpoint.snapshot.settings.enabled || !checkpoint.snapshot.gate.canSearch || !current.gate.canSearch ||
        action === 'read' && (checkpoint.snapshot.settings.sourceReading === 'off' || current.settings.sourceReading === 'off')) {
      throw appError('ABORTED', '这次研究不允许搜索或读取来源。');
    }
  };
  const searchBoundary = async (childSignal: AbortSignal, prepared?: Record<string, string>, action: 'search' | 'read' = 'search') => {
    await assertCurrent();
    await assertAction(action);
    const config = await readConfig();
    if (config.search?.providerId !== searchReceiver) throw appError('STALE_PAGE', '搜索接收方已经变化，请重新提问。');
    const provider = searchReceiver && findSearchProvider(searchReceiver);
    if (!provider) throw appError('SEARCH_FAILED', '还没有配置可用的搜索服务。');
    const credentials = { ...await readSearchCredentials(provider.id) };
    if (provider.configFields.some(field => field.required && !credentials[field.key]?.trim())) {
      throw appError('SEARCH_FAILED', '搜索服务的配置已失效，请重新配置。');
    }
    if (prepared) assertSameCredentials(prepared, credentials);
    const origins = provider.hosts(credentials);
    if (!origins.length || !await browser.permissions.contains({ origins })) throw appError('PERMISSION_MISSING', '搜索服务的访问权限已失效。');
    await assertCurrent();
    // Last authoritative storage read follows all permission/page awaits. Check both the
    // frozen public declaration and private prepared credentials before physical fetch.
    await assertAction(action);
    const fresh = await getSession(identity.tabId);
    const final = await readConfig();
    assertActiveResearch(identity, fresh);
    if (outboundScope(final) !== checkpoint.snapshot.outboundScope || final.search?.providerId !== searchReceiver) {
      throw appError('STALE_PAGE', '外发接收方或范围已经变化，请重新提问。');
    }
    assertOutboundConfirmation(final);
    const model = researchModelSelection(final);
    if (model.modelProvider !== identity.modelProvider || model.modelId !== identity.modelId || model.thinking !== thinking) {
      throw appError('STALE_PAGE', '模型已经变化，请重新提问。');
    }
    assertSameCredentials(credentials, final.search?.credentials?.[provider.id] ?? {});
    if (childSignal.aborted) throw appError('ABORTED', '已停止本次研究。');
    return { provider, credentials };
  };
  const guardedFetch = (childSignal: AbortSignal, credentials: Record<string, string>, action: 'search' | 'read' = 'search'): typeof fetch => {
    const prepared = { ...credentials };
    return async (input, init) => {
      await searchBoundary(childSignal, prepared, action);
      return fetch(input, init);
    };
  };
  return runResearch({ checkpoint, signal, resume, deps: {
    assertCurrent, now: Date.now, onEvent,
    callJson: async (messages, childSignal) => {
      await assertCurrent();
      return callResearchModel({ identity, messages, signal: childSignal, thinking, searchProviderId: searchReceiver, outboundScope: checkpoint.snapshot.outboundScope });
    },
    search: async (action, childSignal) => {
      const { provider, credentials } = await searchBoundary(childSignal);
      return researchSearch({ providerId: provider.id, config: credentials, action, signal: childSignal,
        now: () => new Date(), time: checkpoint.snapshot.gate.time, fetchImpl: guardedFetch(childSignal, credentials) });
    },
    read: async (ids, focus, ledger, childSignal) => {
      await assertCurrent();
      await assertAction('read');
      const selected = findSearchProvider(searchReceiver);
      return readSources({ ids, focus, ledger, mode: checkpoint.snapshot.settings.sourceReading,
        remainingChars: 40_000 - ledger.sources.reduce((sum, source) => sum + (source.content?.length ?? 0), 0),
        signal: childSignal, now: () => new Date(), directReadVerified: DIRECT_READ_VERIFIED,
        hasPermission: origin => browser.permissions.contains({ origins: [`${origin}/*`] }),
        fetchImpl: async (input, init) => { await assertCurrent(); await assertAction('read'); if (childSignal.aborted) throw appError('ABORTED', '已停止本次研究。'); return fetch(input, init); },
        providerRead: selected?.capabilities.content && selected.readSources ? async (sources, readSignal) => {
          const { provider, credentials } = await searchBoundary(readSignal, undefined, 'read');
          return provider.readSources!({ sources, signal: readSignal, config: credentials, fetchImpl: guardedFetch(readSignal, credentials, 'read') });
        } : undefined,
      });
    },
  } });
}
