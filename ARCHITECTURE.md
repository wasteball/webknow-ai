# 知伴架构

> 本页描述公开源码的主要实现边界；用户可见功能和当前限制见 [README.md](README.md)。`webknow-ai` 是仓库和包名，扩展展示名为「知伴」。

## 一条流水线，三种策略

三类请求（阅读导览 / 自由问答 / 引导学习）走同一条流水线，差异只在「提示词文件 + 输出 schema + 校验器」：

```text
意图 → 会话守卫 → 组装上下文 → 策略提示词 → 所选模型供应商调用 → 结构校验(zod)
     → 引用校验(块必须存在) → 写回守卫(地址/改稿/请求身份) → 持久化 → 推送界面
```

流水线在 `src/background/runner.ts`。新增一种**模型输出模式**时，优先复用流水线，只增加策略、schema 与校验器；搜索、知识库等外部能力仍需显式设计协议、权限、网络与数据边界。

## 分层

```text
entrypoints/            扩展入口（薄）
  background.ts         MV3 service worker：注册监听 + 转发事件
  content.ts            runtime 注册的内容脚本（不在 manifest 声明站点）
  sidepanel/            React 侧栏：阅读时的一切（摘要、问答、学习）
  options/              React 设置页：非阅读时的整页界面，独立标签页

src/core/               纯逻辑：无 chrome.*、无 DOM，可单测
  protocol.ts           侧栏 ↔ 后台 ↔ 内容脚本的消息契约（唯一真源）
  session.ts            会话模型、状态机、请求身份与写回判定
  blocks.ts             原文块、上下文组装（超限即拒绝，不静默截断）
  prompts/              三类策略 + harness 约束（harness.ts）
  model-providers.ts    DeepSeek / 智谱官方接口与模型配置
  model-call.ts         SSE、视觉请求、JSON 解析与错误映射
  vision.ts             内容图转述写入证据块，并标明模型转述
  search/               可选搜索供应商及结果来源边界
  ima/                  ima OpenAPI 客户端与阅读笔记构造
  validate.ts           输出校验与引用清洗
  errors.ts limits.ts phase.ts

src/background/         已保存凭证的读取边界与业务网络出口
  router.ts             消息路由、PanelState 组装、页面生命周期
  runner.ts             请求流水线
  model.ts              当前供应商 Key 读取 + 模型与视觉调用（已保存 Key 不回传界面）
  page.ts               与内容脚本的桥（注入、提取、指纹、回跳）
  store.ts              storage.session（会话）/ storage.local（配置与凭证）
  ima.ts                IMA 凭证读取、列库与保存编排

src/content/            只在被调用时读当前页
  extract.ts            正文提取 + 唯一锚点 + DOM 回跳
  pictures.ts           内容图片识别与可请求地址
  trees.ts              可读子树：开放 shadow root 与同源 iframe 的展开克隆
  text.ts               归一化、指纹、CSS 路径

src/sidepanel/          界面 + 端口客户端（侧栏与设置页共用；两边都只经端口与后台说话）
```

**侧栏是工作时的界面，设置是整页界面。** 两者用同一个端口协议连后台：设置页用
`attach(null)`（没有“当前这一页”），从侧栏打开时带 `#<标签页号>` 才 attach 到那一页，
因此“清掉这一页的内容”知道指的是哪一页，而浏览器自带的“扩展选项”入口进来时不指向任何页面。

## 三条不可越过的边界

1. **凭证边界**：初次输入的凭证会短暂存在设置页表单状态，并通过内部命令交给后台；保存后不回传 `PanelState`。持久化读取和对外使用只发生在 background，不进入提示词、会话数据、日志或错误正文。模型 Key 由 `model.ts` 读取，搜索与 IMA 凭证由各自后台路径读取。
2. **外发边界**：只有 `https://api.deepseek.com/*` 是固定的 `host_permissions`。工具栏点击以 `activeTab` 临时授权当前页；换页后从侧栏直接开始时，可能申请覆盖全部 HTTP(S) 网页的可选权限，用户也可重新点击工具栏只授权当前页。智谱、搜索供应商和 IMA 分别按手势申请对应 origin。使用 DeepSeek 时可额外发送内容图片供转述，智谱不读图。正文请求还须由后台按当前接收方核对外发确认；业务网络调用按代码约束只发生在 background。
3. **提示词边界**：`harness.ts` 的规则与输出契约由代码拼接；用户可为 `guide`、`answer`、`learn` 编辑当前生效策略，现成写法仅填入编辑框，不能替换 harness、schema、程序上限、权限、接收方或凭证边界。

## 数据生命周期

| 数据 | 位置 | 清除时机 |
|---|---|---|
| 正文块、摘要、气泡、对话、学习状态 | `storage.session`（浏览会话） | 关闭标签页 / 关闭浏览器 / 用户主动清除 |
| DeepSeek/智谱 Key、模型与三板块策略文本、行为与外观设置、外发确认 | `storage.local`（不同步） | 由对应设置或独立清除操作修改 |
| 搜索供应商配置与凭证 | `storage.local`（不同步） | 停用不会自动删除既有凭证；由对应配置操作修改 |
| IMA 凭证与默认知识库 | `storage.local`（不同步） | “删除 IMA 配置”独立清除；IMA 侧内容不随之删除 |

后台被回收重启后，侧栏从存储重新读取状态，不需要知道后台曾经死过。

## 状态与竞态

- 页面身份 = 标签页 + URL。正文指纹用来发现同一页被改过。
- 每个在途请求有 `run.id`。写回前核对内容脚本里的地址和指纹，并核对请求身份。地址变了就丢掉这次结果并告诉用户。同一地址上指纹变了，仍写回这次结果；用户再发出去时，先按新正文重读再问。请求身份不符则丢弃迟到结果。对不上页面时说明原因，不清掉已有对话。
- 每个标签页同时只允许一个在途请求；停止即 `AbortController.abort()`，并按请求类型恢复到 `READY_TO_START` / `READY` / `LEARNING`。

## 已明确的取舍

- **不申请 `tabs` 权限**：导航检测靠内容脚本上报 + `tabs.onUpdated` 的 status。新页面可重新点击工具栏取得当前页临时授权；侧栏换页入口也提供范围更广的可选网页权限路径。
- **模型请求走流式并累积**：SSE 分片既保活 service worker（30 秒空闲回收），也给出可停止的进度。界面在校验完成前，把读者字段（摘要、回答、反馈等）从半截 JSON 里抽出来按打字机显示；引用、气泡和后续问题仍等完整文本校验通过后再出现。解析与写回仍在完整文本上做。`reasoning_content` 与正文分开累计；有内容时界面默认折叠，展开后可以再合上。思考过程不发回后续请求。
- **读 React 原生 DOM 克隆**：Readability 会改动传入文档，因此永远传克隆；克隆用 `cloneExpanded`
  （主文档 + 展开后的 shadow/同源框架），不能直接 `cloneNode(true)`——那样会漏掉两类正文。
- **不自动滚动加载懒内容**：副作用（改变阅读位置、触发页面发请求）大于收益；改为检测入口并披露。
- **范围控制**：不为 PDF、任意第三方模型或向量检索预留可执行插件接口；内置 DeepSeek 与智谱的官方接口由 `model-providers.ts` 明确列出。
