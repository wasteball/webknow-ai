# 架构

> 面向 webknow-ai 首版（HTML 网页伴随式 AI）。产品合同见 `../docs/PRD.md`。

## 一条流水线，三种策略

三类请求（阅读导览 / 自由问答 / 引导学习）走同一条流水线，差异只在「提示词文件 + 输出 schema + 校验器」：

```text
意图 → 会话守卫 → 组装上下文 → 策略提示词 → DeepSeek 调用 → 结构校验(zod)
     → 引用校验(块必须存在) → 写回守卫(页面身份/内容版本/请求身份) → 持久化 → 推送界面
```

流水线在 `src/background/runner.ts`。**新增能力 = 新增策略文件 + 校验器，不改流水线。**

## 分层

```text
entrypoints/            扩展入口（薄）
  background.ts         MV3 service worker：注册监听 + 转发事件
  content.ts            runtime 注册的内容脚本（不在 manifest 声明站点）
  sidepanel/            React 侧栏

src/core/               纯逻辑：无 chrome.*、无 DOM，可单测
  protocol.ts           侧栏 ↔ 后台 ↔ 内容脚本的消息契约（唯一真源）
  session.ts            会话模型、状态机、请求身份与写回判定
  blocks.ts             原文块、上下文组装（超限即拒绝，不静默截断）
  prompts/              三类策略 + harness 约束（harness.ts）
  deepseek.ts           SSE 解析、宽松 JSON、错误映射
  validate.ts           输出校验与引用清洗
  errors.ts limits.ts phase.ts

src/background/         唯一持有 Key 与唯一网络出口
  router.ts             消息路由、PanelState 组装、页面生命周期
  runner.ts             请求流水线
  model.ts              Key 读取 + 调用（key 不离开这里）
  page.ts               与内容脚本的桥（注入、提取、指纹、回跳）
  store.ts              storage.session（会话）/ storage.local（配置）

src/content/            只在被调用时读当前页
  extract.ts            正文提取 + 唯一锚点 + DOM 回跳（来自 735171c，已验证）
  text.ts               归一化、指纹、CSS 路径

src/sidepanel/          界面 + 端口客户端
```

## 三条不可越过的边界

1. **Key 边界**：`apiKey` 只在 `src/background/model.ts` 读取，直接进请求头。不进界面、提示词、会话数据、日志。
2. **外发边界**：只有 `https://api.deepseek.com/*` 是固定的 `host_permissions`；站点读取权限按需申请（`optional_host_permissions` + 用户手势中的 `permissions.request`）。扩展页有 host 权限，因此不受 CORS 限制；内容脚本没有该豁免，所以网络调用只发生在后台。
3. **提示词边界**：`harness.ts` 的规则与输出契约由代码拼接，用户覆盖只能替换 `learn.ts` 的策略段。教学覆盖无法解除预算、读取 Key、改变接收方或输出格式。

## 数据生命周期

| 数据 | 位置 | 清除时机 |
|---|---|---|
| 正文块、摘要、气泡、对话、学习状态 | `storage.session`（内存） | 关闭标签页 / 关闭浏览器 / 用户主动清除 |
| DeepSeek Key、教学覆盖、外发确认 | `storage.local`（不同步） | 仅由对应独立操作删除 |

后台被回收重启后，侧栏从存储重新读取状态，不需要知道后台曾经死过。

## 状态与竞态

- 页面身份 = 标签页 + URL + 内容版本（正文指纹）。
- 每个在途请求有 `run.id`；写回前同时校验**页面身份仍一致**（问内容脚本要指纹）和**会话与请求身份未变**。任一不符即丢弃迟到结果。
- 每个标签页同时只允许一个在途请求；停止即 `AbortController.abort()`，并按请求类型恢复到 `READY_TO_START` / `READY` / `LEARNING`。

## 已明确的取舍

- **不申请 `tabs` 权限**：导航检测靠内容脚本上报 + `tabs.onUpdated` 的 status，代价是新站点需要一次工具栏点击才能授权。
- **模型请求走流式并累积**：SSE 分片既保活 service worker（30 秒空闲回收），也给出可停止的进度；解析仍在完整文本上做。
- **读 React 原生 DOM 克隆**：Readability 会改动传入文档，因此永远传 `document.cloneNode(true)`。
- **不预置扩展点**：PDF、多供应商、向量检索等都不做接口预留（`产品规划.md` 第 5.2 节）。
