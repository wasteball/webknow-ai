/**
 * 模型供应商注册表。
 *
 * 首版只有 DeepSeek；2026-09-19 用户指令加入智谱。两家都是 OpenAI 兼容的
 * chat/completions + SSE，因此共用同一条传输（`core/deepseek.ts` 的 chatJson），
 * 差异全部收在这张表里：地址、鉴权头、请求体默认值、模型列表、外发接收方名。
 *
 * **每一家的未知项都集中在自己的那一段里**：怀疑某个供应商接不通时，
 * 先看这里，不用翻传输代码。
 *
 * 外发边界：DeepSeek 是内置默认，地址固定在 manifest 的 host_permissions 里；
 * 智谱走 optional_host_permissions，在设置页点"连接"时按用户手势申请，
 * 因此"唯一固定外发目标"仍是 DeepSeek。
 */

export type ProviderId = 'deepseek' | 'zhipu';

export type ModelProvider = {
  id: ProviderId;
  /** 设置页里的显示名。 */
  name: string;
  /** 外发告知里的接收方名称——用户要能一眼看出文字发给了哪家公司。 */
  receiver: string;
  endpoint: string;
  /** 拉模型列表的地址；null 表示这家没有可用接口，直接用内置列表。 */
  modelsEndpoint: string | null;
  /** 内置回退列表，也是模型选择器的候选。 */
  knownModels: string[];
  defaultModel: string;
  /** 该供应商的请求体默认值：JSON 模式、思考开关各家叫法与支持度不同。 */
  bodyDefaults: Record<string, unknown>;
  /** 申请 host 权限用的 origin 模式。 */
  origin: string;
  /** Key 的形态提示，填错时用户能自己看出来。 */
  keyHint: string;
  /** 去哪儿拿 Key。 */
  keyPage: string;
  /** 该供应商是否已在 manifest 里固定授权（DeepSeek 是；其余按需申请）。 */
  fixedHost: boolean;
};

const deepseek: ModelProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  receiver: 'DeepSeek（深度求索）',
  endpoint: 'https://api.deepseek.com/chat/completions',
  modelsEndpoint: 'https://api.deepseek.com/models',
  // 2026-09-18 /models 实测；deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用。
  knownModels: ['deepseek-flash', 'deepseek-v4-pro'],
  defaultModel: 'deepseek-flash',
  /**
   * A0 实测（2026-09-18，真实 Key）：
   * - deepseek-flash 默认开启思考，思考文本会占用 max_tokens；
   *   显式关闭后同一请求 3.4s → 1.7s，摘要与气泡质量无可见下降。
   * - response_format 的 json_object 与流式同时可用。
   * 因此这里固定关闭思考：三类请求都是短结构化输出，不需要长链推理。
   */
  bodyDefaults: {
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
  },
  origin: 'https://api.deepseek.com/*',
  keyHint: '以 sk- 开头',
  keyPage: 'https://platform.deepseek.com/api_keys',
  fixedHost: true,
};

/**
 * 智谱。**本段整体未经真实联调**（加这个供应商时手上没有智谱 Key），
 * 依据是官方文档与 OpenAI 兼容说明：
 * - 端点 POST https://open.bigmodel.cn/api/paas/v4/chat/completions，SSE 与 OpenAI 一致；
 * - 鉴权 `Authorization: Bearer <key>`，key 形如 `xxxxxxxx.xxxxxxxxxxxxxxxx`（不是 sk- 开头）；
 * - response_format 的 json_object **官方文档明确支持**（仅文本模型），故沿用；
 * - 未写入 thinking 开关：智谱各版本对它的支持不一致，宁可用默认行为，
 *   也不塞一个可能 400 的字段。
 *
 * 第一次真机联调时按顺序看这三点：
 * 1. 请求体是否被接受（若 400，先去掉 bodyDefaults 里的 response_format）；
 * 2. 流式分片是否仍是 choices[0].delta.content（是则传输层不用改）；
 * 3. knownModels 里的模型 ID 在你的账号下是否可用——不可用就在设置页手动填。
 */
const zhipu: ModelProvider = {
  id: 'zhipu',
  name: '智谱',
  receiver: '智谱（Zhipu）',
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  // 官方未提供公开的模型列表接口，直接用内置候选 + 设置页手动填写。
  modelsEndpoint: null,
  knownModels: ['glm-4.6', 'glm-4.5-air', 'glm-4.5-flash', 'glm-4.7', 'glm-5.2'],
  defaultModel: 'glm-4.6',
  bodyDefaults: {
    response_format: { type: 'json_object' },
  },
  origin: 'https://open.bigmodel.cn/*',
  keyHint: '形如 xxxxxxxx.xxxxxxxxxxxxxxxx（不是 sk- 开头）',
  keyPage: 'https://open.bigmodel.cn/usercenter/apikeys',
  fixedHost: false,
};

export const MODEL_PROVIDERS: ModelProvider[] = [deepseek, zhipu];

export const DEFAULT_PROVIDER: ProviderId = 'deepseek';

export function findProvider(id: string | undefined): ModelProvider {
  return MODEL_PROVIDERS.find((provider) => provider.id === id) ?? MODEL_PROVIDERS[0]!;
}
