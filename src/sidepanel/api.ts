import { browser } from 'wxt/browser';

import { appError } from '../core/errors';
import type { Command, Event, PanelState, Reply } from '../core/protocol';
import type { AgentEvent, RunIdentity } from '../core/search/agent-types';
import { diagramIdFromUrl, diagramKey, matchesDiagramViewer, parseDiagramRecord } from '../core/diagram-record';

/**
 * 侧栏与后台之间的长连接。
 * 后台被回收后端口会断开：这里自动重连并重新取一次状态，界面不需要知道这件事（NFR-004）。
 */

export type Client = {
  send: (command: Command) => Promise<Reply>;
  dispose: () => void;
};

export function createClient(handlers: {
  onState: (state: PanelState) => void;
  onProgress: (chars: number, draft: string, reasoning: string) => void;
  onAgent?: (event: AgentEvent) => void;
  onQuote?: (event: Extract<Event, { type: 'quote' }>) => void;
}): Client {
  let port: ReturnType<typeof browser.runtime.connect> | null = null;
  let nextId = 1;
  let disposed = false;
  let attachment: Extract<Command, { type: 'attach' }> | null = null;
  let state: PanelState | null = null;
  let latestAgent: AgentEvent | null = null;
  const pending = new Map<number, (reply: Reply) => void>();

  const connect = () => {
    if (disposed) return;
    const current = browser.runtime.connect({ name: 'webknow' });
    port = current;
    current.onMessage.addListener((raw) => {
      if (disposed || port !== current) return;
      const event = raw as Event;
      if (event.type === 'state') {
        if (!attachment || event.state.tabId === attachment.tabId) {
          let nextState = event.state;
          const incoming = nextState.busy?.agent;
          const remembered = latestAgent;
          const stillCurrent = remembered && nextState.busy?.kind === 'answer' &&
            nextState.tabId === remembered.identity.tabId && nextState.sessionId === remembered.identity.sessionId &&
            nextState.pageUrl === remembered.identity.url && nextState.settings.provider === remembered.identity.modelProvider &&
            nextState.researchPending?.runId === remembered.identity.runId &&
            ['running', 'waiting'].includes(nextState.researchPending.status);
          if (remembered && nextState.busy && stillCurrent &&
              (!incoming || (sameRun(incoming.identity, remembered.identity) && incoming.seq < remembered.seq))) {
            nextState = { ...nextState, researchDetails: remembered.details ?? nextState.researchDetails,
              busy: { ...nextState.busy, agent: remembered } };
          } else latestAgent = incoming ?? null;
          state = nextState;
          handlers.onState(nextState);
        }
      }
      else if (event.type === 'agent') {
        const next = event.event;
        const pendingResearch = state?.researchPending;
        if (attachment?.tabId !== next.identity.tabId || state?.tabId !== next.identity.tabId ||
            state.sessionId !== next.identity.sessionId || state.busy?.kind !== 'answer' ||
            state.pageUrl !== next.identity.url || state.settings.provider !== next.identity.modelProvider ||
            pendingResearch?.runId !== next.identity.runId ||
            !['running', 'waiting'].includes(pendingResearch.status) ||
            (latestAgent && (!sameRun(latestAgent.identity, next.identity) || next.seq <= latestAgent.seq))) return;
        latestAgent = next;
        state = { ...state, researchDetails: next.details ?? state.researchDetails,
          busy: { ...state.busy, agent: next, draft: '', reasoning: '' } };
        handlers.onAgent?.(next);
      }
      else if (event.type === 'progress') {
        if (!state?.busy?.agent && !['running', 'waiting'].includes(state?.researchPending?.status ?? '')) {
          handlers.onProgress(event.chars, event.draft, event.reasoning);
        }
      }
      else if (event.type === 'quote' && event.tabId === attachment?.tabId) handlers.onQuote?.(event);
      else if (event.type === 'reply') {
        pending.get(event.id)?.(event.reply);
        pending.delete(event.id);
      }
    });
    current.onDisconnect.addListener(() => {
      if (port !== current) return;
      port = null;
      state = null;
      latestAgent = null;
      for (const resolve of pending.values()) {
        resolve({
          ok: false,
          error: appError('INTERNAL', '连接断了一下，正在自动重连。请再试一次刚才的操作。', true),
        });
      }
      pending.clear();
      if (!disposed) setTimeout(connect, 250);
    });
    // Reconnect restores only the subscription, never a possibly billable command.
    if (attachment) current.postMessage({ id: nextId++, command: attachment });
  };

  connect();

  return {
    send(command) {
      if (command.type === 'attach') { attachment = command; state = null; latestAgent = null; }
      if (!port) {
        return Promise.resolve({
          ok: false,
          error: appError('INTERNAL', '还没连上，请再试一次。', true),
        });
      }
      const id = nextId++;
      return new Promise<Reply>((resolve) => {
        pending.set(id, resolve);
        try {
          port?.postMessage({ id, command });
        } catch {
          pending.delete(id);
          resolve({ ok: false, error: appError('INTERNAL', '这条操作没送出去，请再试一次。', true) });
        }
      });
    },
    dispose() {
      disposed = true;
      port?.disconnect();
      port = null;
    },
  };
}

function sameRun(left: RunIdentity, right: RunIdentity): boolean {
  return left.tabId === right.tabId && left.sessionId === right.sessionId && left.runId === right.runId &&
    left.url === right.url && left.fingerprint === right.fingerprint &&
    left.modelProvider === right.modelProvider && left.modelId === right.modelId;
}

/** 当前阅读标签页；从文章打开的设置页继续关联来源文章。 */
export async function activeTabId(): Promise<number | null> {
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  }
  if (tab?.id === undefined) return null;

  // 从输入框打开搜索设置时，继续关联原文章，避免卸载输入区丢掉草稿。
  // 只识别自家设置页；来源必须仍存在且在同一窗口。
  try {
    // 未申请 tabs 权限时，连自家设置页的 tab.url 也可能不可见。
    const ownView = browser.extension.getViews({ type: 'tab', tabId: tab.id })[0] as Window | undefined;
    const visibleUrl = tab.pendingUrl ?? tab.url ?? ownView?.location.href;
    const url = new URL(visibleUrl ?? '');
    const viewerUrl = browser.runtime.getURL('/viewer.html');
    const diagramId = diagramIdFromUrl(url.href, viewerUrl);
    if (diagramId) {
      const key = diagramKey(diagramId);
      const stored = await browser.storage.session.get(key);
      const record = parseDiagramRecord(stored[key]);
      if (record && matchesDiagramViewer(record, tab, url.href, viewerUrl)) {
        const source = await browser.tabs.get(record.sourceTabId);
        if (source.windowId === record.sourceWindowId) return source.id ?? null;
      }
      return tab.id;
    }
    const options = new URL(browser.runtime.getURL('/options.html'));
    const sourceId = Number(url.searchParams.get('tab'));
    if (
      url.protocol === options.protocol && url.host === options.host && url.pathname === options.pathname &&
      Number.isSafeInteger(sourceId) && sourceId > 0 && sourceId !== tab.id
    ) {
      const source = await browser.tabs.get(sourceId);
      if (source.windowId === tab.windowId) return sourceId;
    }
  } catch {
    // 没有 URL 授权或原文章已关闭时，仍按当前标签页处理。
  }
  return tab.id;
}

/** 设置页先加载再激活，避免尚无扩展视图的瞬间把侧栏切到空白新标签。 */
export async function openSettingsTab(url: string): Promise<void> {
  const tab = await browser.tabs.create({ url, active: false });
  const id = tab.id;
  if (id === undefined) return;
  if (tab.status !== 'complete') {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        browser.tabs.onUpdated.removeListener(updated);
        browser.tabs.onRemoved.removeListener(removed);
        if (error) reject(error);
        else resolve();
      };
      const updated = (tabId: number, change: { status?: string }) => {
        if (tabId === id && change.status === 'complete') finish();
      };
      const removed = (tabId: number) => {
        if (tabId === id) finish(new Error('设置标签页已关闭'));
      };
      browser.tabs.onUpdated.addListener(updated);
      browser.tabs.onRemoved.addListener(removed);
      // 监听注册之前也可能已经加载完，补查一次防止漏掉事件。
      void browser.tabs.get(id).then((current) => {
        if (current.status === 'complete') finish();
      }, (error: Error) => finish(error));
    });
  }
  await browser.tabs.update(id, { active: true });
}
