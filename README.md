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
sudo npx playwright install-deps chromium   # 需要系统库（WSL 下缺 libnspr4 等）
pnpm test:e2e
```

E2E 只做冒烟：后台启动、侧栏状态推导、Key 不进入会话存储。
**真实 DeepSeek 调用不在自动化测试里**——那需要用户自己的 Key，属于 A0 的人工验证项。

## 当前状态（2026-09-18）

- 本仓库是按新架构重建的首版：`core` 纯逻辑 + 后台流水线 + 内容脚本 + 侧栏界面。
- 正文提取、唯一锚点、DOM 回跳沿用 2026-08-22 版本（`735171c`）并已重跑测试。
- **尚未用真实 DeepSeek Key 跑通**：模型 ID（当前写死 `deepseek-flash`，`deepseek-chat` 已于 2026-07-24 停用）、
  CORS 行为、错误映射与费用都还没有实测证据。`src/core/deepseek.ts` 的契约在实测前不算冻结。
- 尚未在真实 Chrome 中完成人工验收。

## 边界

- 只支持 `http(s)` 上公开、有连续正文的 HTML 页面；不支持登录态、PDF、视频、列表页与主要依赖图片的页面。
- 正文、摘要、气泡、对话与学习状态只保留当前浏览会话；Key 与教学配置本地持久保存且不参与浏览器同步。
- 站点读取权限按需申请：在新站点首次点击“开始伴读”时会请求该站点权限，授权后该站点后续访问不再需要。
