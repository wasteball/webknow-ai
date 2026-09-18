import { storage } from 'wxt/utils/storage';

import { appError } from '../core/errors';
import type { SummaryLength } from '../core/limits';
import {
  normalizeSettings,
  type FontSize,
  type PromptOverrides,
  type SettingsPatch,
} from '../core/settings';
import type { Skill, SkillChoice, SkillTarget } from '../core/skills';
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

/**
 * 用户设置（产品化改造 F2）。非敏感设置通过 saveSettings 命令整体保存；
 * Key 仍走独立命令。数值类设置只能在 limits.ts 的硬上限内生效（core/settings.ts 归一化）。
 */
export type Config = {
  apiKey?: string;
  outbound?: { version: string; acceptedAt: number; receiver: string };
  /** 模型 ID；缺省用内置默认（DEEPSEEK_MODEL）。 */
  model?: string;
  prompts?: PromptOverrides;
  /** 每个板块选择的技能 ID（技能=提示词预设）。 */
  skillChoices?: SkillChoice;
  /** 用户自建的技能；内置技能在代码里，不进存储。 */
  skills?: Skill[];
  /** 学习提问预算（1–10，默认 5），在开始学习时固定进会话。 */
  learningBudget?: number;
  /** 首屏探索气泡上限（0–3，默认 3）。 */
  maxBubbles?: number;
  /** 摘要长度偏好（默认 medium）。 */
  summaryLength?: SummaryLength;
  appearance?: { fontSize?: FontSize };
};

/** 内容脚本被授权注入后记录的当前页信息（一次工具栏点击的结果）。 */
export type Pending = { url: string; origin: string; at: number };

const CONFIG_KEY: `local:${string}` = 'local:config';
const sessionKey = (tabId: number): `session:${string}` => `session:sess:${tabId}`;
const pendingKey = (tabId: number): `session:${string}` => `session:pending:${tabId}`;

export async function readConfig(): Promise<Config> {
  const stored = await storage.getItem<Config & { teachingPrompt?: string }>(CONFIG_KEY);
  if (!stored) return {};
  // 一次性迁移：旧版只有教学提示词覆盖（teachingPrompt），新版是三板块 prompts.learn。
  if (typeof stored.teachingPrompt === 'string') {
    const { teachingPrompt: old, ...rest } = stored;
    const migrated: Config = {
      ...rest,
      prompts: { ...(rest.prompts ?? {}), learn: old || undefined },
    };
    if (!migrated.prompts?.learn) delete migrated.prompts?.learn;
    await storage.setItem(CONFIG_KEY, migrated);
    return migrated;
  }
  return stored;
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

/** 清除单个板块的提示词覆盖（恢复默认）；不触碰 Key、会话与其他设置。 */
export async function clearPromptOverride(target: SkillTarget): Promise<void> {
  const current = await readConfig();
  if (!current.prompts || !(target in current.prompts)) return;
  const { [target]: _removed, ...rest } = current.prompts;
  const prompts = Object.keys(rest).length ? rest : undefined;
  await storage.setItem(CONFIG_KEY, prompts ? { ...current, prompts } : { ...current, prompts: undefined });
}

/** 保存自定义技能：同 id 覆盖更新，其余技能不动。 */
export async function saveCustomSkill(skill: Skill): Promise<void> {
  const current = await readConfig();
  const skills = (current.skills ?? []).filter((item) => item.id !== skill.id);
  skills.push(skill);
  await storage.setItem(CONFIG_KEY, { ...current, skills });
}

/** 删除自定义技能：同时取消各板块对该技能的选择。 */
export async function deleteCustomSkill(id: string): Promise<void> {
  const current = await readConfig();
  const skills = (current.skills ?? []).filter((item) => item.id !== id);
  const next: Config = { ...current, skills };
  if (current.skillChoices) {
    const choices = { ...current.skillChoices };
    for (const target of Object.keys(choices) as SkillTarget[]) {
      if (choices[target] === id) delete choices[target];
    }
    if (Object.keys(choices).length) next.skillChoices = choices;
    else delete next.skillChoices;
  }
  await storage.setItem(CONFIG_KEY, next);
}

/**
 * 保存非敏感设置（产品化改造 F2）。
 * prompts 采用逐项合并语义：传空字符串 = 恢复该板块默认；未提到的板块保持不变。
 * 数值范围与格式由 core/settings.normalizeSettings 归一化，非法条目被丢弃。
 */
export async function applySettings(patch: SettingsPatch): Promise<void> {
  const current = await readConfig();
  const clean = normalizeSettings(patch);
  const next: Config = { ...current };

  if (clean.model !== undefined) next.model = clean.model;
  if (clean.learningBudget !== undefined) next.learningBudget = clean.learningBudget;
  if (clean.maxBubbles !== undefined) next.maxBubbles = clean.maxBubbles;
  if (clean.summaryLength !== undefined) next.summaryLength = clean.summaryLength;
  if (clean.fontSize !== undefined) next.appearance = { ...current.appearance, fontSize: clean.fontSize };

  if (patch.prompts !== undefined) {
    const merged: PromptOverrides = { ...current.prompts };
    for (const target of ['guide', 'answer', 'learn'] as const) {
      if (typeof patch.prompts[target] !== 'string') continue;
      const kept = clean.prompts?.[target];
      if (kept) merged[target] = kept;
      else delete merged[target];
    }
    if (Object.keys(merged).length) next.prompts = merged;
    else delete next.prompts;
  }

  if (patch.skillChoices !== undefined) {
    const merged: SkillChoice = { ...current.skillChoices };
    for (const target of ['guide', 'answer', 'learn'] as const) {
      if (typeof patch.skillChoices[target] !== 'string') continue;
      const kept = clean.skillChoices?.[target];
      if (kept) merged[target] = kept;
      else delete merged[target];
    }
    if (Object.keys(merged).length) next.skillChoices = merged;
    else delete next.skillChoices;
  }

  await storage.setItem(CONFIG_KEY, next);
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
