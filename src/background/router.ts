import { browser } from 'wxt/browser';

import { appError, fromThrown, type AppError } from '../core/errors';
import { derivePhase } from '../core/phase';
import type { Command, Event, PanelState, PortRequest, Reply } from '../core/protocol';
import { LIMITS } from '../core/limits';
import { MODEL_PROVIDERS, findProvider } from '../core/model-providers';
import { effectiveSettings } from '../core/settings';
import { validateCustomSkill } from '../core/skills';
import { BUILTIN_SEARCH_PROVIDERS, searchWithProvider } from '../core/search/registry';
import { createSession, emptySession, markStale } from '../core/session';
import { hasImaCredentials, listImaKnowledgeBases, saveReadingToIma } from './ima';
import { listModels, testConnection } from './model';
import { extractPage, jumpToOriginal, watchPage } from './page';
import { abortRun, handleIntent, type RunnerHooks } from './runner';
import {
  OUTBOUND_NOTICE_VERSION,
  applySettings,
  clearAllSessions,
  clearImaConfig,
  clearPending,
  deleteApiKey,
  deleteCustomSkill,
  dropSession,
  getPending,
  getSession,
  putSession,
  readApiKey,
  readConfig,
  readSearchCredentials,
  saveApiKey,
  saveCustomSkill,
  saveImaConfig,
  saveSearchConfig,
  setPending,
  writeConfig,
} from './store';

/**
 * 侧栏 ↔ 后台的消息路由。所有状态都从存储读出来再组装，因此后台被回收重启后
 * 侧栏仍能恢复可理解状态（NFR-004）。
 */

type PanelPort = { raw: { postMessage: (message: Event) => void }; tabId: number | null };

const ports = new Set<PanelPort>();

/** 当前供应商对应的外发接收方名称；确认记录与界面文案都用它。 */
export async function currentReceiver(): Promise<string> {
  return findProvider((await readConfig()).provider).receiver;
}

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

async function permissionFor(url: string | null): Promise<'granted' | 'missing' | 'unknown'> {
  const origin = url ? originOf(url) : null;
  if (!origin) return 'unknown';
  try {
    const granted = await browser.permissions.contains({ origins: [`${origin}/*`] });
    return granted ? 'granted' : 'missing';
  } catch {
    return 'unknown';
  }
}

export async function buildPanelState(tabId: number | null): Promise<PanelState> {
  const config = await readConfig();
  const provider = findProvider(config.provider);
  const providerKeys = Object.fromEntries(
    MODEL_PROVIDERS.map((item) => [item.id, Boolean(config.apiKeys?.[item.id]?.trim())]),
  ) as Record<string, boolean>;
  const hasKey = providerKeys[provider.id] === true;
  const settings = {
    ...effectiveSettings(config),
    provider: provider.id,
    providerKeys,
    customSkills: config.skills ?? [],
    search: searchStatus(config),
    ima: {
      enabled: await hasImaCredentials(),
      kbName: config.ima?.kbName?.trim() || null,
    },
  };
  // 换供应商 = 换接收方：旧确认只对原来那家有效，换个名字就要重新确认一次。
  const outboundConfirmed =
    config.outbound?.version === OUTBOUND_NOTICE_VERSION && config.outbound?.receiver === provider.receiver;

  if (tabId === null) {
    return {
      tabId: null,
      pageUrl: null,
      pageTitle: '',
      permission: 'unknown',
      phase: derivePhase({ hasKey, permission: 'unknown', sessionState: null, unsupportedReason: null }),
      sessionState: null,
      hasKey,
      settings,
      outboundConfirmed,
      completeness: null,
      guide: null,
      chat: [],
      learning: null,
      busy: null,
      error: null,
      budget: { used: 0, total: settings.learningBudget },
      unsupportedReason: '还没有取得当前页面的地址。请点击工具栏图标授权当前页面。',
    };
  }

  const session = await getSession(tabId);
  const pending = await getPending(tabId);
  const url = await urlForTab(tabId, session?.url ?? null, pending?.url ?? null);
  const permission = url ? await permissionFor(url) : 'missing';
  // 可可靠识别的“不支持页面”才给 UNSUPPORTED，其余失败仍走 ERROR（FR-003/FR-035）。
  const unsupportedReason =
    session?.error && ['PAGE_UNSUPPORTED', 'EXTRACT_FAILED'].includes(session.error.code)
      ? session.error.message
      : null;

  return {
    tabId,
    pageUrl: url,
    pageTitle: session?.title ?? '',
    permission,
    phase: derivePhase({
      hasKey,
      permission,
      sessionState: session?.state ?? null,
      unsupportedReason,
    }),
    sessionState: session?.state ?? null,
    hasKey,
    settings,
    outboundConfirmed,
    completeness: session?.completeness ?? null,
    guide: session?.guide ?? null,
    chat: session?.chat ?? [],
    learning: session?.learning ?? null,
    busy: session?.run
      ? { kind: session.run.kind, chars: 0 }
      : null,
    error: session?.error ?? null,
    budget: {
      used: session?.learning?.used ?? 0,
      total: session?.learning?.budget ?? settings.learningBudget,
    },
    unsupportedReason,
  };
}

/** 联网搜索的界面可见状态（F3）：只有启用状态与名称，凭证不出后台。 */
function searchStatus(config: { search?: { providerId?: string; credentials?: Record<string, Record<string, string>> } }): {
  enabled: boolean;
  providerName: string | null;
  hasCredentials: boolean;
} {
  const providerId = config.search?.providerId;
  if (!providerId) return { enabled: false, providerName: null, hasCredentials: false };
  const provider = BUILTIN_SEARCH_PROVIDERS.find((item) => item.id === providerId);
  if (!provider) return { enabled: false, providerName: null, hasCredentials: false };
  const saved = config.search?.credentials?.[providerId] ?? {};
  return {
    enabled: true,
    providerName: provider.name,
    hasCredentials: provider.configFields.every(
      (field) => !field.required || Boolean(saved[field.key]?.trim()),
    ),
  };
}

/**
 * 页面地址的三个来源：本标签页的会话 → 工具栏点击留下的记录 → 已授权站点的标签页查询。
 * 第三条是白送的：站点权限已授予时，`tabs.get` 直接就能给出地址，用户不必再点工具栏图标。
 */
async function urlForTab(tabId: number, sessionUrl: string | null, pendingUrl: string | null): Promise<string | null> {
  if (sessionUrl) return sessionUrl;
  if (pendingUrl) return pendingUrl;
  try {
    const tab = await browser.tabs.get(tabId);
    return tab.url ?? null;
  } catch {
    return null;
  }
}

/** 扩展安装或更新后：清掉旧会话并刷新所有已打开的面板。 */
export async function resetAfterUpdate(): Promise<void> {
  await clearAllSessions();
  await pushAllStates();
}

async function pushAllStates(): Promise<void> {
  const tabIds = new Set([...ports].map((port) => port.tabId));
  for (const tabId of tabIds) await pushState(tabId);
}

const hooks: RunnerHooks = {
  onState: (tabId) => {
    void pushState(tabId);
  },
  onProgress: (tabId, chars) => {
    broadcast(tabId, { type: 'progress', chars });
  },
};

async function pushState(tabId: number | null): Promise<void> {
  broadcast(tabId, { type: 'state', state: await buildPanelState(tabId) });
}

function broadcast(tabId: number | null, event: Event): void {
  for (const port of ports) {
    if (port.tabId !== tabId) continue;
    try {
      port.raw.postMessage(event);
    } catch {
      ports.delete(port);
    }
  }
}

/** 任何会改变当前标签页状态的外部事件（导航、关闭）都走这里，保持与 runner 同一套推送。 */
export async function notifyTab(tabId: number): Promise<void> {
  await pushState(tabId);
}

export function registerPanelPort(port: {
  onMessage: { addListener: (cb: (message: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
  postMessage: (message: Event) => void;
}): void {
  const entry: PanelPort = { raw: port, tabId: null };
  ports.add(entry);
  port.onDisconnect.addListener(() => {
    ports.delete(entry);
  });
  port.onMessage.addListener((raw) => {
    void onCommand(entry, raw);
  });
}

async function onCommand(entry: PanelPort, raw: unknown): Promise<void> {
  const request = raw as PortRequest;
  if (!request || typeof request.id !== 'number' || !request.command) return;
  if (request.command.type === 'attach') entry.tabId = request.command.tabId;
  const reply = await dispatch(request.command, entry);
  try {
    entry.raw.postMessage({ type: 'reply', id: request.id, reply });
  } catch {
    ports.delete(entry);
  }
}

async function dispatch(command: Command, port?: PanelPort): Promise<Reply> {
  try {
    switch (command.type) {
      case 'attach': {
        // 面板刚连上（或切换了标签页）：必须立刻推一次完整状态，否则界面只能停在“正在连接后台”。
        // 同一标签页可能有多个端口（重开侧栏、诊断连接），attach 后统一广播，保证各端口状态一致。
        if (port) {
          broadcast(port.tabId, { type: 'state', state: await buildPanelState(port.tabId) });
        }
        return { ok: true };
      }

      case 'start':
        return await startSession(command.tabId);

      case 'stop':
        return abortRun(command.tabId)
          ? { ok: true }
          : { ok: false, error: appError('INTERNAL', '现在没有正在进行的事情。', false) };

      case 'ask':
        // 逐题联网开关由界面决定：这里必须原样透传，否则开关是死的（F3）。
        return finish(
          await handleIntent(
            { kind: 'ask', tabId: command.tabId, question: command.question, search: command.search },
            hooks,
          ),
        );

      case 'explore': {
        const session = await getSession(command.tabId);
        const bubble = session?.guide?.bubbles.find((item) => item.id === command.bubbleId);
        if (!bubble) {
          return { ok: false, error: appError('STALE_PAGE', '这个话题过期了（页面内容变了），重新开始伴读吧。', true) };
        }
        return finish(
          await handleIntent({ kind: 'ask', tabId: command.tabId, question: bubble.question }, hooks),
        );
      }

      case 'learnStart':
        return finish(await handleIntent({ kind: 'learnStart', tabId: command.tabId, goal: command.goal }, hooks));
      case 'learnAnswer':
        return finish(
          await handleIntent(
            {
              kind: 'learnAnswer',
              tabId: command.tabId,
              text: command.text,
              choices: command.choices,
            },
            hooks,
          ),
        );
      case 'learnAssist':
        return finish(
          await handleIntent({ kind: 'learnAssist', tabId: command.tabId, assist: command.action }, hooks),
        );
      case 'learnEnd':
        return finish(await handleIntent({ kind: 'learnEnd', tabId: command.tabId }, hooks));

      case 'jump': {
        const session = await getSession(command.tabId);
        const block = session?.blocks.find((item) => item.id === command.blockId);
        if (!block) {
          return { ok: false, error: appError('JUMP_FAILED', '这段原文已经不在这一页上了。', false) };
        }
        const outcome = await jumpToOriginal(command.tabId, block.anchor);
        if (outcome.outcome === 'failed') {
          return { ok: false, error: appError('JUMP_FAILED', `没能回到原文：${outcome.reason}`, false) };
        }
        return { ok: true, message: outcome.outcome === 'jumped' ? undefined : '原文位置已移动，已定位到新的对应位置。' };
      }

      case 'clearSession':
        await dropSession(command.tabId);
        await pushState(command.tabId);
        return { ok: true };

      case 'clearAllSessions': {
        const count = await clearAllSessions();
        await pushState(null);
        return { ok: true, message: `已清掉 ${count} 个页面的内容。你的钥匙和设置都没有动。` };
      }

      case 'saveKey': {
        const key = command.key.trim();
        const provider = findProvider(command.provider);
        if (!key) return { ok: false, error: appError('NO_KEY', `先填上 ${provider.name} 的钥匙。`, false) };
        // 保存前执行固定的最小连接测试；测试不发送网页正文（FR-020）。
        await testConnection(provider.id, key);
        await saveApiKey(provider.id, key);
        await pushAllStates();
        return { ok: true, message: `确认能用，${provider.name} 的钥匙已经存在这个浏览器里了。` };
      }

      case 'testKey': {
        await testConnection(command.provider, command.key);
        return { ok: true, message: '连得上。这次测试没有发送网页内容，只花极少的钱。' };
      }

      case 'deleteKey':
        await deleteApiKey(command.provider);
        await pushAllStates();
        return { ok: true, message: '钥匙删掉了。页面内容和设置都没有动。' };

      case 'saveSettings': {
        await applySettings(command.patch);
        await pushAllStates();
        return { ok: true, message: '设置已保存。' };
      }

      case 'saveSkill': {
        const clean = validateCustomSkill(command.skill);
        if (!clean.ok) return { ok: false, error: clean.error };
        await saveCustomSkill(clean.value);
        await pushAllStates();
        return { ok: true, message: '技能已保存。' };
      }

      case 'deleteSkill': {
        await deleteCustomSkill(command.id);
        await pushAllStates();
        return { ok: true, message: '技能已删除。' };
      }

      case 'saveSearchConfig': {
        const providerId = command.providerId;
        if (providerId !== null && !BUILTIN_SEARCH_PROVIDERS.some((provider) => provider.id === providerId)) {
          return { ok: false, error: appError('BAD_OUTPUT', '这个搜索供应商不存在。', false) };
        }
        await saveSearchConfig({ providerId, credentials: command.credentials });
        await pushAllStates();
        return { ok: true, message: providerId ? '联网搜索已启用。' : '联网搜索已停用。' };
      }

      case 'testSearch': {
        // host 权限由界面在用户手势中先行申请；这里只做一次真实的最小搜索。
        const credentials = {
          ...(await readSearchCredentials(command.providerId)),
          ...(command.credentials ?? {}),
        };
        try {
          const results = await searchWithProvider({
            providerId: command.providerId,
            config: credentials,
            query: 'DeepSeek API 文档',
            count: 3,
            signal: AbortSignal.timeout(20_000),
          });
          return { ok: true, message: `搜索通了，拿到 ${results.length} 条结果。` };
        } catch (error) {
          return { ok: false, error: fromThrown(error) };
        }
      }

      case 'saveImaConfig': {
        await saveImaConfig({ clientId: command.clientId, apiKey: command.apiKey });
        await pushAllStates();
        return { ok: true, message: '知识库凭证已保存。' };
      }

      case 'saveImaKb': {
        await saveImaConfig({ kbId: command.kbId, kbName: command.kbName });
        await pushAllStates();
        return { ok: true, message: '默认知识库已保存。' };
      }

      case 'listImaKb': {
        try {
          const items = await listImaKnowledgeBases(command.credentials);
          return { ok: true, data: { imaKbItems: items } };
        } catch (error) {
          return { ok: false, error: fromThrown(error) };
        }
      }

      case 'deleteImaConfig':
        await clearImaConfig();
        await pushAllStates();
        return { ok: true, message: '知识库凭证已删除。已存入 ima 的内容不受影响。' };

      case 'saveToIma': {
        const session = await getSession(command.tabId);
        if (!session || session.state !== 'READY') {
          return { ok: false, error: appError('STALE_PAGE', '这一页还没有可保存的阅读成果。', true) };
        }
        try {
          const outcome = await saveReadingToIma(session);
          const parts = [outcome.urlSaved ? '网页已入库' : null, outcome.noteSaved ? '笔记已保存' : null].filter(
            Boolean,
          );
          return { ok: true, message: `已保存：${parts.join('，')}。在 ima 里随时查看。` };
        } catch (error) {
          return { ok: false, error: fromThrown(error) };
        }
      }

      case 'listModels': {
        try {
          const key = await readApiKey(command.provider);
          if (!key) {
            // 没有钥匙就退回内置候选，而不是报错——设置页只是想把选择器填满。
            return { ok: true, data: { models: findProvider(command.provider).knownModels } };
          }
          const models = await listModels(command.provider, key);
          return { ok: true, data: { models } };
        } catch (error) {
          return { ok: false, error: fromThrown(error) };
        }
      }

      case 'confirmOutbound':
        await writeConfig({
          outbound: { version: OUTBOUND_NOTICE_VERSION, acceptedAt: Date.now(), receiver: await currentReceiver() },
        });
        return { ok: true };

      default:
        return { ok: false, error: appError('INTERNAL', '未知指令。') };
    }
  } catch (error) {
    return { ok: false, error: fromThrown(error) };
  }
}

function finish(error: AppError | null): Reply {
  return error ? { ok: false, error } : { ok: true };
}

/**
 * 逐页面启动（FR-004/FR-005/FR-025）：
 * - 已有仍有效的会话：只复用，不重新读取；
 * - 否则先提取正文（这一步之后才有可外发的正文），再生成首屏。
 */
async function startSession(tabId: number): Promise<Reply> {
  const existing = await getSession(tabId);
  if (existing && (existing.state === 'READY' || existing.state === 'LEARNING')) {
    await pushState(tabId);
    return { ok: true, message: '这一页刚才已经读过，直接用了上次的结果。' };
  }

  try {
    const pending = await getPending(tabId);
    const knownUrl = await urlForTab(tabId, existing?.url ?? null, pending?.url ?? null);
    const expectedOrigin = knownUrl ? originOf(knownUrl) : null;
    // 连地址都不知道就没法申请权限，也不该去尝试读取再报一个误导人的“这类页面读不了”。
    if (!expectedOrigin) {
      throw appError(
        'PERMISSION_MISSING',
        '还不知道你正在看哪个网站。请先点一下浏览器右上角的 webknow-ai 图标，再点下面的按钮。',
        false,
      );
    }
    const payload = await extractPage(tabId, expectedOrigin);
    const session = createSession(tabId, payload);
    await putSession(session);
    await watchPage(tabId);
    await pushState(tabId);
  } catch (error) {
    const failure = fromThrown(error);
    const fallback = existing ?? emptySession(tabId, '');
    await putSession({ ...fallback, state: 'ERROR', error: failure, updatedAt: Date.now() });
    await pushState(tabId);
    return { ok: false, error: failure };
  }

  void handleIntent({ kind: 'guide', tabId }, hooks);
  return { ok: true };
}

/** 内容脚本上报的可检测页面变化：旧结果立即陈旧，且不再作为当前页上下文（FR-005）。 */
export async function onPageChanged(tabId: number, url: string): Promise<void> {
  const session = await getSession(tabId);
  if (!session || session.url === url) return;
  if (session.run) abortRun(tabId);
  await putSession(markStale(session, url));
  await pushState(tabId);
}

/**
 * 导航或刷新开始：无法在不申请 tabs 权限的前提下读取新地址，因此保守地把旧结果标为陈旧。
 * 宁可多要一次点击“开始伴读”，也不让上一页的结果留在新页面上（FR-005/FR-024）。
 */
export async function onTabNavigating(tabId: number): Promise<void> {
  // 导航后上一次工具栏点击留下的地址已经作废：留着会导致向错误的网站申请权限。
  await clearPending(tabId);
  const session = await getSession(tabId);
  if (!session) return;
  if (session.run) abortRun(tabId);
  await putSession(markStale(session));
  await pushState(tabId);
}

/** 标签页关闭：清除该标签页的会话数据（FR-030）。 */
export async function onTabRemoved(tabId: number): Promise<void> {
  await dropSession(tabId);
  await clearPending(tabId);
}

/** 工具栏点击：先同步打开侧栏（必须无 await），再用 activeTab 记录当前页地址。 */
export async function onActionClicked(tab: { id?: number; url?: string }): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;
  // sidePanel.open 必须在用户手势里同步调用，前面不能有任何 await。
  void browser.sidePanel.open({ tabId });
  const url = tab.url;
  const origin = url ? originOf(url) : null;
  if (url && origin) await setPending(tabId, { url, origin, at: Date.now() });
  await pushState(tabId);
}
