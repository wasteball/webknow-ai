import { browser } from 'wxt/browser';

import { appError } from '../core/errors';
import type { Command, Event, PanelState, Reply } from '../core/protocol';

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
  onProgress: (chars: number) => void;
}): Client {
  let port: ReturnType<typeof browser.runtime.connect> | null = null;
  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, (reply: Reply) => void>();

  const connect = () => {
    if (disposed) return;
    port = browser.runtime.connect({ name: 'webknow' });
    port.onMessage.addListener((raw) => {
      const event = raw as Event;
      if (event.type === 'state') handlers.onState(event.state);
      else if (event.type === 'progress') handlers.onProgress(event.chars);
      else if (event.type === 'reply') {
        pending.get(event.id)?.(event.reply);
        pending.delete(event.id);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const resolve of pending.values()) {
        resolve({
          ok: false,
          error: appError('INTERNAL', '与后台的连接中断，正在重连；请重试刚才的操作。', true),
        });
      }
      pending.clear();
      if (!disposed) setTimeout(connect, 250);
    });
  };

  connect();

  return {
    send(command) {
      if (!port) {
        return Promise.resolve({
          ok: false,
          error: appError('INTERNAL', '与后台的连接尚未恢复，请重试。', true),
        });
      }
      const id = nextId++;
      return new Promise<Reply>((resolve) => {
        pending.set(id, resolve);
        try {
          port?.postMessage({ id, command });
        } catch {
          pending.delete(id);
          resolve({ ok: false, error: appError('INTERNAL', '消息未能送达后台。', true) });
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

/** 侧栏所属窗口的当前标签页；读不到地址不影响使用，只是还不知道要看哪一页。 */
export async function activeTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) return tab.id;
  const [fallback] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return fallback?.id ?? null;
}
