# webknow-ai（源码）

面向普通读者的网页伴随式 AI：在公开、可提取连续正文的 HTML 页面旁，生成短摘要与探索气泡，
支持自由提问与用户自愿进入的“AI 问我”。Chrome Manifest V3 侧栏扩展，只接入用户自己的 DeepSeek Key。

产品合同、范围与验收标准见 `../docs/PRD.md`；代码结构与边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 命令

```bash
pnpm install
pnpm dev            # 开发模式（自动打开带扩展的浏览器）
pnpm build          # 构建到 .output/chrome-mv3
pnpm test           # Vitest 单测（core 纯逻辑 + 内容脚本提取/回跳）
pnpm typecheck      # tsc --noEmit
pnpm check          # typecheck + test + build
```

手动加载：Chrome → `chrome://extensions` → 打开开发者模式 → “加载已解压的扩展程序” → 选 `.output/chrome-mv3`。
点击工具栏图标打开侧栏。

## 端到端测试

```bash
pnpm exec playwright install chromium   # 首次
pnpm test:e2e                           # 会先做 e2e 模式构建到 .output/chrome-mv3-e2e
```

覆盖：后台启动、侧栏状态推导、Key 不进入会话存储、扩展页与后台直连 DeepSeek（CORS 豁免），
以及主路径（点击 → 注入内容脚本 → 提取正文 → 首屏）。首屏截图写在 `test-results/panel-ready.png`。

两个环境前提：

- **系统库**：Chromium 需要 `libnss3`/`libnspr4`/`libasound2` 等。没有 root 时可以只下载不安装：
  `apt-get download libnspr4 libnss3 libasound2`，`dpkg -x *.deb <本地目录>`，
  然后 `LD_LIBRARY_PATH=<本地目录>/usr/lib/x86_64-linux-gnu pnpm test:e2e`。
- **中文字体**：无头容器若未装 CJK 字体，截图里的中文会显示为方块，不影响断言。

`--mode e2e` 会额外静态授予 `http://127.0.0.1/*`：浏览器授权弹窗是无头环境点不到的 UI，
因此测试用本地回环页替代站点授权。**发布构建不含这条权限**，也不要用 e2e 模式出包。

真实模型接入单独一条，默认跳过，需要显式提供 Key（会产生少量费用）：

```bash
DEEPSEEK_KEY=sk-... pnpm vitest run tests/live.deepseek.test.ts
```

它跑的是产品代码本身（`chatJson` + 三个校验器），不是 curl，可作为 A0/A2 的可重复证据。

## 当前状态（2026-09-18）

- 本仓库是按新架构重建的首版：`core` 纯逻辑 + 后台流水线 + 内容脚本 + 侧栏界面。
- 正文提取、唯一锚点、DOM 回跳沿用 2026-08-22 版本（`735171c`）并已重跑测试。
- **DeepSeek 接入已实测**（真实 Key，2026-09-18）：`deepseek-flash` 可用；流式 +
  `response_format: json_object` 可用；实测延迟 0.6–1.5 秒；网页里的注入句被当作数据处理。
  实测同时发现默认思考会占用输出预算并让延迟翻倍，因此请求固定 `thinking: {type:"disabled"}`。
- **仍未验证**：扩展在真实 Chrome 中的 CORS 表现（DeepSeek 响应不带
  `access-control-allow-origin`，扩展页依赖 host 权限豁免，只能在浏览器里证实）、
  权限与启动流程的人工可用性、以及学习提问是否严格"一次只问一个主要问题"。

## 边界

- 只支持 `http(s)` 上公开、有连续正文的 HTML 页面；不支持登录态、PDF、视频、列表页与主要依赖图片的页面。
- 正文、摘要、气泡、对话与学习状态只保留当前浏览会话；Key 与教学配置本地持久保存且不参与浏览器同步。
- 站点读取权限按需申请：在新站点首次点击“开始伴读”时会请求该站点权限，授权后该站点后续访问不再需要。
