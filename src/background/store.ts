import { storage } from 'wxt/utils/storage';

import { appError } from '../core/errors';
import type { SummaryLength } from '../core/limits';
import { findProvider, type ProviderId } from '../core/model-providers';
import { rememberThinking, type ThinkingStore } from '../core/model-thinking';
import {
  normalizeSettings,
  type DiagramMode,
  type FontSize,
  type PromptOverrides,
  type SettingsPatch,
} from '../core/settings';
import { findSkill, type Skill, type SkillTarget } from '../core/skills';
import type { PageSession } from '../core/session';

/**
 * 存储分层（FR-030/FR-031）：
 * - 会话数据（正文、摘要、气泡、对话、学习状态）放 storage.session：内存驻留，
 *   关闭浏览器即消失；关闭标签页时由 router 显式清除对应键。
 * - Key、有效配置、外发确认放 storage.local，且不使用浏览器同步存储。
 */

/**
 * 外发告知版本：接收方或发送范围实质变化时必须更新，旧确认随之失效（FR-022）。
 *
 * 2026-09-19.2：加入智谱。此前接收方恒为 DeepSeek，现在取决于用户选哪家——
 * 接收方集合发生实质变化，因此提版，让老用户对新边界重新确认一次。
 * 具体接收方名称不在这里写死，改由所选供应商给出（core/model-providers.ts）。
 */
export const OUTBOUND_NOTICE_VERSION = '2026-09-19.2';

/** 外发确认只对当前版本与当前接收方有效。 */
export function hasOutboundConfirmation(config: Config): boolean {
  return config.outbound?.version === OUTBOUND_NOTICE_VERSION &&
    config.outbound?.receiver === findProvider(config.provider).receiver;
}

/**
 * 用户设置（产品化改造 F2）。非敏感设置通过 saveSettings 命令整体保存；
 * Key 仍走独立命令。数值类设置只能在 limits.ts 的硬上限内生效（core/settings.ts 归一化）。
 */
export type Config = {
  /** 当前用哪家模型供应商；缺省 DeepSeek。 */
  provider?: ProviderId;
  /** 每家的 Key 分开存：换供应商不用重填，也不会把 A 家的 Key 发给 B 家。 */
  apiKeys?: Partial<Record<ProviderId, string>>;
  /** 每家的模型选择；缺省用该供应商的内置默认。 */
  models?: Partial<Record<ProviderId, string>>;
  /** 每家、每个模型各记的思考档。缺省按模型表。 */
  thinking?: ThinkingStore;
  outbound?: { version: string; acceptedAt: number; receiver: string };
  prompts?: PromptOverrides;
  /** 用户自建的写法模板；内置模板在代码里，不进存储。 */
  skills?: Skill[];
  /** 出题方式（F5）：mixed=模型按内容选择；quiz=总是选择题；open=总是开放问答。 */
  learningStyle?: 'mixed' | 'quiz' | 'open';
  /** 联网搜索（F3）：providerId=null 表示未启用。凭证只存这里，不进界面。 */
  search?: {
    agent?: Partial<import('../core/search/agent-types').AgentSettings>;
    providerId?: string;
    credentials?: Record<string, Record<string, string>>;
  };
  /** 知识库（K-ima）：凭证与默认知识库；只存这里，只由 background 边界读取。 */
  ima?: {
    clientId?: string;
    apiKey?: string;
    kbId?: string;
    kbName?: string;
  };
  /** 首屏探索气泡上限（0–3，默认 3）。 */
  maxBubbles?: number;
  /** 摘要长度偏好（默认 medium）。 */
  summaryLength?: SummaryLength;
  appearance?: { fontSize?: FontSize };
  /** 回答里的图表（默认 auto）。 */
  diagrams?: DiagramMode;
};

/** 内容脚本被授权注入后记录的当前页信息（一次工具栏点击的结果）。 */
export type Pending = { url: string; origin: string; at: number };

const CONFIG_KEY: `local:${string}` = 'local:config';
const sessionKey = (tabId: number): `session:${string}` => `session:sess:${tabId}`;
const pendingKey = (tabId: number): `session:${string}` => `session:pending:${tabId}`;

type LegacyConfig = Config & {
  teachingPrompt?: string;
  apiKey?: string;
  model?: string;
  /** 旧版：每个板块「选中的技能」。生效的东西藏在这里，界面上看不到，已废弃。 */
  skillChoices?: Partial<Record<SkillTarget, string>>;
};

export async function readConfig(): Promise<Config> {
  const stored = await storage.getItem<LegacyConfig>(CONFIG_KEY);
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
  // 一次性迁移：旧版「选中的技能」是一个看不见的生效来源，界面上点了却看不出变化。
  // 现在只有一个来源——编辑框里的文字。把当时选中的模板正文落成用户自己的文字，
  // 这样升级后生效内容不变，而且终于看得见、改得动。
  if (stored.skillChoices) {
    const { skillChoices, ...rest } = stored;
    const prompts: PromptOverrides = { ...rest.prompts };
    for (const target of ['guide', 'answer', 'learn'] as const) {
      const id = skillChoices[target];
      if (!id || prompts[target]) continue;
      const body = findSkill(id, rest.skills ?? [])?.body;
      if (body) prompts[target] = body;
    }
    const migrated: Config = { ...rest };
    if (Object.keys(prompts).length) migrated.prompts = prompts;
    await storage.setItem(CONFIG_KEY, migrated);
    return migrated;
  }
  // 一次性迁移：单供应商时代的单个 apiKey / model，拆成按供应商存的那两份。
  // 不迁移的话老用户升级后会变成"没有 Key"，等于把已经配好的东西弄丢了。
  if (stored.apiKey !== undefined || stored.model !== undefined) {
    const { apiKey, model, ...rest } = stored;
    const migrated: Config = { ...rest };
    if (apiKey) migrated.apiKeys = { ...(rest.apiKeys ?? {}), deepseek: apiKey };
    if (model) migrated.models = { ...(rest.models ?? {}), deepseek: model };
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
export async function readApiKey(provider: ProviderId): Promise<string | null> {
  const key = (await readConfig()).apiKeys?.[provider]?.trim();
  return key ? key : null;
}

/** 当前供应商有没有配好钥匙——界面据此决定是"连接"还是"选模型"。 */
export async function hasApiKey(provider: ProviderId): Promise<boolean> {
  return (await readApiKey(provider)) !== null;
}

export async function saveApiKey(provider: ProviderId, key: string): Promise<void> {
  const current = await readConfig();
  await storage.setItem(CONFIG_KEY, {
    ...current,
    apiKeys: { ...(current.apiKeys ?? {}), [provider]: key.trim() },
  });
}

/** 只删这一家的钥匙，另一家的不动（独立清除，FR-033）。 */
export async function deleteApiKey(provider: ProviderId): Promise<void> {
  const current = await readConfig();
  const apiKeys = { ...(current.apiKeys ?? {}) };
  delete apiKeys[provider];
  const next: Config = { ...current };
  if (Object.keys(apiKeys).length) next.apiKeys = apiKeys;
  else delete next.apiKeys;
  await storage.setItem(CONFIG_KEY, next);
}

/** 清除单个板块的提示词覆盖（恢复默认）；不触碰 Key、会话与其他设置。 */
export async function clearPromptOverride(target: SkillTarget): Promise<void> {
  const current = await readConfig();
  if (!current.prompts || !(target in current.prompts)) return;
  const { [target]: _removed, ...rest } = current.prompts;
  const prompts = Object.keys(rest).length ? rest : undefined;
  await storage.setItem(CONFIG_KEY, prompts ? { ...current, prompts } : { ...current, prompts: undefined });
}

/** 保存搜索供应商配置（F3）：providerId=null 表示停用；凭证按供应商合并保存。 */
export async function saveSearchConfig(input: {
  providerId: string | null;
  credentials?: Record<string, string>;
}): Promise<void> {
  const current = await readConfig();
  const search = { ...current.search };
  if (input.credentials) {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.credentials)) {
      if (typeof value === 'string' && value.trim() && key.length <= 40) {
        clean[key] = value.trim().slice(0, 500);
      }
    }
    search.credentials = { ...(search.credentials ?? {}) };
    if (Object.keys(clean).length) search.credentials[input.providerId ?? ''] = clean;
  }
  if (input.providerId === null) delete search.providerId;
  else search.providerId = input.providerId;
  const next: Config = { ...current, search };
  if (!next.search?.providerId && !next.search?.credentials) delete next.search;
  await storage.setItem(CONFIG_KEY, next);
}

/** 读取指定供应商的凭证（仅 background 边界内）。 */
export async function readSearchCredentials(
  providerId: string,
): Promise<Record<string, string>> {
  return (await readConfig()).search?.credentials?.[providerId] ?? {};
}

/** 保存 ima 凭证与默认知识库（K-ima）；空值字段被丢弃，不覆盖已有有效值。 */
export async function saveImaConfig(patch: {
  clientId?: string;
  apiKey?: string;
  kbId?: string;
  kbName?: string;
}): Promise<void> {
  const current = await readConfig();
  const ima = { ...current.ima };
  for (const key of ['clientId', 'apiKey', 'kbId', 'kbName'] as const) {
    const value = patch[key]?.trim();
    if (value) ima[key] = value.slice(0, 500);
  }
  const next: Config = { ...current, ima };
  if (!Object.keys(next.ima ?? {}).length) delete next.ima;
  await storage.setItem(CONFIG_KEY, next);
}

/** 删除 ima 凭证与默认知识库（独立操作，不触碰 Key、会话与其他设置）。 */
export async function clearImaConfig(): Promise<void> {
  const current = await readConfig();
  if (!current.ima) return;
  const { ima: _removed, ...rest } = current;
  await storage.setItem(CONFIG_KEY, rest);
}

/** 保存写法模板：同 id 覆盖更新，其余模板不动。 */
export async function saveCustomSkill(skill: Skill): Promise<void> {
  const current = await readConfig();
  const skills = (current.skills ?? []).filter((item) => item.id !== skill.id);
  skills.push(skill);
  await storage.setItem(CONFIG_KEY, { ...current, skills });
}

/** 删除写法模板。已经填进编辑框的文字不受影响——那段文字是用户自己的了。 */
export async function deleteCustomSkill(id: string): Promise<void> {
  const current = await readConfig();
  const skills = (current.skills ?? []).filter((item) => item.id !== id);
  await storage.setItem(CONFIG_KEY, { ...current, skills });
}

/**
 * 保存非敏感设置（产品化改造 F2）。
 * prompts 采用逐项合并语义：传空字符串 = 恢复该板块默认；未提到的板块保持不变。
 * 数值范围与格式由 core/settings.normalizeSettings 归一化，非法条目被丢弃。
 */
export async function applySettings(patch: SettingsPatch): Promise<boolean> {
  const current = await readConfig();
  const clean = normalizeSettings(patch);
  const next: Config = { ...current };

  const providerChanged = clean.provider !== undefined && clean.provider !== findProvider(current.provider).id;
  if (clean.provider !== undefined) next.provider = clean.provider;
  if (providerChanged) delete next.outbound;
  // 模型按供应商存：切供应商时各自记住各自的选择。
  if (clean.model !== undefined) {
    const provider = findProvider(next.provider).id;
    next.models = { ...(next.models ?? {}), [provider]: clean.model };
  }
  if (clean.learningStyle !== undefined) next.learningStyle = clean.learningStyle;
  if (clean.maxBubbles !== undefined) next.maxBubbles = clean.maxBubbles;
  if (clean.summaryLength !== undefined) next.summaryLength = clean.summaryLength;
  if (clean.fontSize !== undefined) next.appearance = { ...current.appearance, fontSize: clean.fontSize };
  if (clean.diagrams !== undefined) next.diagrams = clean.diagrams;
  if (clean.thinking !== undefined) {
    const thinking = rememberThinking(
      { provider: next.provider, models: next.models, thinking: next.thinking },
      { provider: next.provider, model: clean.model, thinking: clean.thinking },
    );
    if (thinking) next.thinking = thinking;
  }

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

  await storage.setItem(CONFIG_KEY, next);
  return providerChanged;
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
