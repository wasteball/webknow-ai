import { browser } from 'wxt/browser';

import { appError, fromThrown, type AppError } from '../core/errors';
import { derivePhase } from '../core/phase';
import type { Command, Event, PanelState, PortRequest, Reply } from '../core/protocol';
import { LIMITS } from '../core/limits';
import { createSession, emptySession, markStale } from '../core/session';
import { validateTeachingPrompt } from '../core/validate';
import { testConnection } from './model';
import { extractPage, jumpToOriginal, watchPage } from './page';
import { abortRun, handleIntent, type RunnerHooks } from './runner';
import {
  OUTBOUND_NOTICE_VERSION,
  OUTBOUND_RECEIVER,
  clearAllSessions,
  clearPending,
  clearTeachingPrompt,
  deleteApiKey,
  dropSession,
  getPending,
  getSession,
  putSession,
  readConfig,
  saveApiKey,
  setPending,
  writeConfig,
} from './store';

/**
 * 侧栏 ↔ 后台的消息路由。所有状态都从存储读出来再组装，因此后台被回收重启后
 * 侧栏仍能恢复可理解状态（NFR-004）。
 */

type PanelPort = { raw: { postMessage: (message: Event) => void }; tabId: number | null };

const ports = new Set<PanelPort>();

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
  const hasKey = Boolean(config.apiKey?.trim());
  const outboundConfirmed = config.outbound?.version === OUTBOUND_NOTICE_VERSION;

  if (tabId === null) {
    return {
      tabId: null,
      pageUrl: null,
      pageTitle: '',
      permission: 'unknown',
      phase: derivePhase({ hasKey, permission: 'unknown', sessionState: null, unsupportedReason: null }),
      sessionState: null,
      hasKey,
      teachingPromptIsCustom: Boolean(config.teachingPrompt?.trim()),
      teachingPrompt: config.teachingPrompt ?? '',
      outboundConfirmed,
      completeness: null,
      guide: null,
      chat: [],
      learning: null,
      busy: null,
      error: null,
      budget: { used: 0, total: 0 },
      unsupportedReason: '还没有取得当前页面的地址。请点击工具栏图标授权当前页面。',
    };
  }

  const session = await getSession(tabId);
  const pending = await getPending(tabId);
  const url = session?.url ?? pending?.url ?? null;
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
    teachingPromptIsCustom: Boolean(config.teachingPrompt?.trim()),
    teachingPrompt: config.teachingPrompt ?? '',
    outboundConfirmed,
    completeness: session?.completeness ?? null,
    guide: session?.guide ?? null,
    chat: session?.chat ?? [],
    learning: session?.learning ?? null,
    busy: session?.run
      ? { kind: session.run.kind, chars: 0 }
      : null,
    error: session?.error ?? null,
    budget: { used: session?.learning?.used ?? 0, total: LIMITS.learningBudget },
    unsupportedReason,
  };
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
        if (port) {
          const state = await buildPanelState(port.tabId);
          try {
            port.raw.postMessage({ type: 'state', state });
          } catch {
            ports.delete(port);
          }
        }
        return { ok: true };
      }

      case 'start':
        return await startSession(command.tabId);

      case 'stop':
        return abortRun(command.tabId)
          ? { ok: true }
          : { ok: false, error: appError('INTERNAL', '当前没有正在进行的生成。', false) };

      case 'ask':
        return finish(await handleIntent({ kind: 'ask', tabId: command.tabId, question: command.question }, hooks));

      case 'explore': {
        const session = await getSession(command.tabId);
        const bubble = session?.guide?.bubbles.find((item) => item.id === command.bubbleId);
        if (!bubble) {
          return { ok: false, error: appError('STALE_PAGE', '这个探索方向已失效，请重新开始伴读。', true) };
        }
        return finish(
          await handleIntent({ kind: 'ask', tabId: command.tabId, question: bubble.question }, hooks),
        );
      }

      case 'learnStart':
        return finish(await handleIntent({ kind: 'learnStart', tabId: command.tabId, goal: command.goal }, hooks));
      case 'learnAnswer':
        return finish(await handleIntent({ kind: 'learnAnswer', tabId: command.tabId, text: command.text }, hooks));
      case 'learnAssist':
        return finish(
          await handleIntent({ kind: 'learnAssist', tabId: command.tabId, assist: command.action }, hooks),
        );
      case 'learnEnd':
        return finish(await handleIntent({ kind: 'learnEnd', tabId: command.tabId }, hooks));

      case 'learnExit': {
        // 结束学习只回到 READY：正文、摘要与问答记录都保留（FR-011）。
        const session = await getSession(command.tabId);
        if (!session) return { ok: false, error: appError('STALE_PAGE', '当前没有可用的页面会话。', true) };
        await putSession({ ...session, state: 'READY', updatedAt: Date.now() });
        await pushState(command.tabId);
        return { ok: true };
      }

      case 'jump': {
        const session = await getSession(command.tabId);
        const block = session?.blocks.find((item) => item.id === command.blockId);
        if (!block) {
          return { ok: false, error: appError('JUMP_FAILED', '这条原文依据已不在当前内容版本中。', false) };
        }
        const outcome = await jumpToOriginal(command.tabId, block.anchor);
        if (outcome.outcome === 'failed') {
          return { ok: false, error: appError('JUMP_FAILED', `无法回到原文：${outcome.reason}`, false) };
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
        return { ok: true, message: `已清除 ${count} 个标签页的会话数据，Key 与教学配置未改动。` };
      }

      case 'saveKey': {
        const key = command.key.trim();
        if (!key) return { ok: false, error: appError('NO_KEY', '请先填写 DeepSeek Key。', false) };
        // 保存前执行固定的最小连接测试；测试不发送网页正文（FR-020）。
        await testConnection(key);
        await saveApiKey(key);
        await pushAllStates();
        return { ok: true, message: '连接测试通过，Key 已保存在本扩展的本地存储中。' };
      }

      case 'testKey': {
        await testConnection(command.key);
        return { ok: true, message: '连接测试通过。本次测试没有发送网页正文，可能产生少量费用。' };
      }

      case 'deleteKey':
        await deleteApiKey();
        await pushAllStates();
        return { ok: true, message: 'Key 已删除。会话内容与教学配置未改动。' };

      case 'saveTeachingPrompt': {
        const clean = validateTeachingPrompt(command.text);
        if (!clean.ok) return { ok: false, error: clean.error };
        await writeConfig({ teachingPrompt: clean.value });
        return { ok: true, message: '教学提示词已保存，将用于之后新开始的学习会话。' };
      }

      case 'resetTeachingPrompt':
        await clearTeachingPrompt();
        return { ok: true, message: '已恢复内置默认教学提示词，Key 与其他设置未改动。' };

      case 'confirmOutbound':
        await writeConfig({
          outbound: { version: OUTBOUND_NOTICE_VERSION, acceptedAt: Date.now(), receiver: OUTBOUND_RECEIVER },
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
    return { ok: true, message: '已复用本次浏览会话中仍然有效的首屏结果。' };
  }

  try {
    const payload = await extractPage(tabId);
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
