# 开发说明

> 使用者请看 [README.md](README.md)。本页是构建、测试和维护说明。
>
> 产品合同与验收标准见 `../docs/PRD.md`；代码结构与边界见 [ARCHITECTURE.md](ARCHITECTURE.md)；
> 产品文档索引见 `../README.md`。

## 命令

```bash
pnpm install
pnpm dev            # 开发模式（自动打开带扩展的浏览器）
pnpm build          # 构建到 .output/chrome-mv3
pnpm zip            # 产出可分发的 .output/webknow-ai-<版本>-chrome.zip
pnpm test           # Vitest 单测（core 纯逻辑 + 内容脚本提取/回跳）
pnpm typecheck      # tsc --noEmit
pnpm check          # typecheck + test + build
```

手动加载：Chrome → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `.output/chrome-mv3`。
点击工具栏图标打开侧栏。

## 测试

| 文件 | 覆盖 | 是否需要真实 Key |
|---|---|---|
| `tests/deepseek.test.ts` | SSE 跨分片解析、错误映射、截断处理、请求体固定项 | 否 |
| `tests/validate.test.ts` | 引用必须落在本地块、来源降级、模式与动作匹配、教学提示词校验 | 否 |
| `tests/session.test.ts` | 并发限制、迟到结果丢弃、状态恢复、预算 | 否 |
| `tests/extract.test.ts` | 正文提取、唯一锚点、原文回跳、歧义不误跳、内容版本 | 否（jsdom） |
| `tests/e2e/*.spec.ts` | 打包扩展在真实 Chromium 里的启动、状态推导、CORS 豁免、主路径首屏 | 主路径需要 |

```bash
pnpm exec playwright install chromium   # 首次
pnpm test:e2e                           # 先做 e2e 模式构建到 .output/chrome-mv3-e2e
```

真实模型接入单独一条，默认跳过，需要显式提供 Key（会产生少量费用）：

```bash
DEEPSEEK_KEY=sk-... pnpm vitest run tests/live.deepseek.test.ts
```

它跑的是产品代码本身（`chatJson` + 三个校验器），不是 curl，可作为 A0/A2 的可重复证据。

### 环境前提

- **系统库**：Chromium 需要 `libnss3`/`libnspr4`/`libasound2` 等。没有 root 时可以只下载不安装：
  `apt-get download libnspr4 libnss3 libasound2` → `dpkg -x *.deb <本地目录>` →
  `LD_LIBRARY_PATH=<本地目录>/usr/lib/x86_64-linux-gnu pnpm test:e2e`。
- **中文字体**：无头容器若未装 CJK 字体，截图里的中文会显示为方块，不影响断言。

### e2e 模式构建

`--mode e2e` 会额外静态授予 `http://127.0.0.1/*`：浏览器授权弹窗是无头环境点不到的 UI，
因此测试用本地回环页替代站点授权。**发布构建不含这条权限**，也不要用 e2e 模式出包。

## 视觉读图基准

在决定视觉能力是否进入产品之前，先用这个拿数字（结论见 `../docs/视觉读图实测.md`）：

```bash
npx playwright test tests/e2e/chart-fixture.spec.ts   # 造 14 张有标准答案的图表到 .bench/charts
DEEPSEEK_KEY=sk-... python3 scripts/vision-bench.py   # 逐张调用视觉模型并打分
```

两条实测得到的硬约束，改这块代码时必须保留：

- **视觉请求必须关闭思考**（`thinking: {"type": "disabled"}`）。开启时输出预算会被推理吃光，
  实测出现过返回空答案。
- **视觉模型是 `deepseek-v4-flash-vision-exp`**，它不出现在 `GET /models` 的返回里，但可以调用。

## 生成文档截图

```bash
pnpm build:e2e
DEEPSEEK_KEY=sk-... npx playwright test tests/e2e/screenshots.spec.ts
```

图片写到 `docs/images/`，供 README 引用；UI 改动后重跑即可更新。

## 权限边界

发布构建的 manifest 只声明：

- `permissions`: `storage`、`sidePanel`、`scripting`
- `host_permissions`: `https://api.deepseek.com/*`
- `optional_host_permissions`: `https://*/*`、`http://*/*`（用户在点击"开始伴读"时按站点授权）

没有 `tabs`，没有 `<all_urls>`。页面地址来自内容脚本上报与一次性工具栏点击，不靠 `tabs` 权限。

## 当前状态（2026-09-18）

- 本仓库是按新架构重建的首版：`core` 纯逻辑 + 后台流水线 + 内容脚本 + 侧栏界面。
- 正文提取、唯一锚点、DOM 回跳沿用 2026-08-22 版本（`735171c`）并已重跑测试。
- **DeepSeek 接入已实测**（真实 Key）：`deepseek-flash` 可用；流式 + `response_format: json_object`
  可用；延迟 0.6–1.5 秒；网页里的注入句被当作数据处理。实测发现默认思考会占用输出预算并让延迟翻倍，
  因此请求固定 `thinking: {"type":"disabled"}`。
- **已在真实 Chromium 中端到端跑通**：后台启动、面板状态推导、CORS 豁免、主路径首屏。
- **仍未验证**：站点授权弹窗的人工体验、普通读者能否独立完成配置、真实费用计量、
  错误注入矩阵、可访问性专项。路线图处于 A0，未通过该阶段门。

## 已知限制

- 只支持 `http(s)` 上公开、有连续正文的 HTML 页面；不支持登录态、PDF、视频、列表页与主要依赖图片的页面。
- 正文超过约 4.5 万字或 400 个块时直接阻断，不静默截断。
- 浏览器外壳界面（`chrome://extensions`、工具栏）无法自动化截图或点击，相关验证只能人工完成。
