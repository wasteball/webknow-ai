import { storage } from 'wxt/utils/storage';

import { appError } from '../core/errors';
import type { PageSession } from '../core/session';

/**
 * 存储分层（FR-030/FR-031）：
 * - 会话数据（正文、摘要、气泡、对话、学习状态）放 storage.session：内存驻留，
 *   关闭浏览器即消失；关闭标签页时由 router 显式清除对应键。
 * - Key、有效配置、外发确认放 storage.local，且不使用浏览器同步存储。
 */

/** 外发告知版本：接收方或发送范围实质变化时必须更新，旧确认随之失效（FR-022）。 */
export const OUTBOUND_NOTICE_VERSION = '2026-09-18.1';
export const OUTBOUND_RECEIVER = 'DeepSeek（深度求索）';

export type Config = {
  apiKey?: string;
  teachingPrompt?: string;
  outbound?: { version: string; acceptedAt: number; receiver: string };
};

/** 内容脚本被授权注入后记录的当前页信息（一次工具栏点击的结果）。 */
export type Pending = { url: string; origin: string; at: number };

const CONFIG_KEY: `local:${string}` = 'local:config';
const sessionKey = (tabId: number): `session:${string}` => `session:sess:${tabId}`;
const pendingKey = (tabId: number): `session:${string}` => `session:pending:${tabId}`;

export async function readConfig(): Promise<Config> {
  return (await storage.getItem<Config>(CONFIG_KEY)) ?? {};
}

export async function writeConfig(patch: Partial<Config>): Promise<void> {
  const current = await readConfig();
  await storage.setItem(CONFIG_KEY, { ...current, ...patch });
}

/** 仅在 background 的网络边界内调用；返回值不得进入界面、日志或提示词（FR-032）。 */
export async function readApiKey(): Promise<string | null> {
  const key = (await readConfig()).apiKey?.trim();
  return key ? key : null;
}

export async function hasApiKey(): Promise<boolean> {
  return (await readApiKey()) !== null;
}

export async function saveApiKey(key: string): Promise<void> {
  await writeConfig({ apiKey: key.trim() });
}

export async function deleteApiKey(): Promise<void> {
  const current = await readConfig();
  const { apiKey: _removed, ...rest } = current;
  await storage.setItem(CONFIG_KEY, rest);
}

/** 恢复默认只删除教学覆盖，不触碰 Key、会话与其他设置（FR-028/FR-033）。 */
export async function clearTeachingPrompt(): Promise<void> {
  const current = await readConfig();
  const { teachingPrompt: _removed, ...rest } = current;
  await storage.setItem(CONFIG_KEY, rest);
}

export async function getSession(tabId: number): Promise<PageSession | null> {
  return (await storage.getItem<PageSession>(sessionKey(tabId))) ?? null;
}

export async function putSession(session: PageSession): Promise<void> {
  try {
    await storage.setItem(sessionKey(session.tabId), session);
  } catch {
    throw appError(
      'STORAGE_FAILED',
      '会话内容未能写入本地存储，界面保留上一次有效内容。可清除当前会话后重试。',
      true,
    );
  }
}

export async function dropSession(tabId: number): Promise<void> {
  await storage.removeItem(sessionKey(tabId));
}

/** 清除全部会话数据，不触碰 Key 与教学配置（FR-033）。 */
export async function clearAllSessions(): Promise<number> {
  const snapshot = await storage.snapshot('session');
  const keys = Object.keys(snapshot).filter((key) => /^(sess|pending):/.test(key));
  if (keys.length) {
    await storage.removeItems(keys.map((key) => `session:${key}` as `session:${string}`));
  }
  return keys.length;
}

export async function setPending(tabId: number, pending: Pending): Promise<void> {
  await storage.setItem(pendingKey(tabId), pending);
}

export async function getPending(tabId: number): Promise<Pending | null> {
  return (await storage.getItem<Pending>(pendingKey(tabId))) ?? null;
}

export async function clearPending(tabId: number): Promise<void> {
  await storage.removeItem(pendingKey(tabId));
}
