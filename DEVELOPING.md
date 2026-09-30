# 开发说明

> 使用者请看 [README.md](README.md)。本页是构建、测试和维护说明。
>
> 对外产品范围见 [README.md](README.md)；代码结构与边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。产品规划、BRD 和 PRD 保存在项目工作台资料中，不属于本公开源码仓库。

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
点击工具栏里的WebKnow AI图标打开侧栏，再点当前页阅读入口开始。

## 测试

| 文件 | 覆盖 | 是否需要真实 Key |
|---|---|---|
| `tests/model-call.test.ts` | SSE 跨分片解析、错误映射、截断处理、请求体固定项 | 否 |
| `tests/validate.test.ts` | 引用必须落在本地块、来源降级、模式与动作匹配、教学提示词校验 | 否 |
| `tests/session.test.ts` | 并发限制、迟到结果丢弃、状态恢复、程序上限 | 否 |
| `tests/page-drift.test.ts` | 同一页改稿仍写回，换页或对不上页面时说明原因 | 否 |
| `tests/extract.test.ts` | 正文提取、唯一锚点、原文回跳、歧义不误跳、内容版本 | 否（jsdom） |
| `tests/model-settings.test.tsx` | 查看配置与使用服务分开、连接失败保留输入、权限拒绝、生成中禁用 | 否（jsdom） |
| `tests/conversation.test.tsx`、`tests/conversation-scroll.test.tsx`、`tests/learn-history.test.ts` | 题目只出现一次、停止恢复、草稿与回看位置、学习历史隔离 | 否 |
| `tests/diagram-view.test.ts`、`tests/diagram-window.test.ts` | 视角计算、独立窗口回退、记录清理、导航后身份与来源校验 | 否 |
| `tests/e2e/*.spec.ts` | 打包扩展在真实 Chromium 里的启动、状态推导、CORS 豁免、主路径首屏 | 主路径需要 |

```bash
pnpm exec playwright install chromium   # 首次
pnpm test:e2e                           # 先做 e2e 模式构建到 .output/chrome-mv3-e2e
```

真实模型接入单独一条，默认跳过，需要显式提供 Key（会产生少量费用）：

```bash
DEEPSEEK_KEY=sk-... pnpm vitest run tests/live.deepseek.test.ts
ZHIPU_KEY=... pnpm vitest run tests/live.zhipu.test.ts
```

它跑的是产品代码本身（`chatJson` + 三个校验器），不是 curl，可作为 A0/A2 的可重复证据。

### 环境前提

- **系统库**：Chromium 需要 `libnss3`/`libnspr4`/`libasound2` 等。没有 root 时可以只下载不安装：
  `apt-get download libnspr4 libnss3 libasound2` → `dpkg -x *.deb <本地目录>` →
  `LD_LIBRARY_PATH=<本地目录>/usr/lib/x86_64-linux-gnu pnpm test:e2e`。
- **中文字体**：无头容器若未装 CJK 字体，截图里的中文会显示为方块，不影响断言。

### e2e 模式构建

`--mode e2e` 会额外静态授予 `http://127.0.0.1/*` 和 `https://open.bigmodel.cn/*`：浏览器授权弹窗是无头环境点不到的 UI，因此测试用本地回环页替代站点授权，并让智谱主路径可被自动化验证。**发布构建不含这两条固定权限**，也不要用 e2e 模式出包。智谱在正式包中仍由连接／使用按钮按手势申请权限。

## 视觉读图基准

DeepSeek 的有限内容图转述已经进入伴读；继续用以下基准检查图表数字和语义准确率。一次合成样本结果不能替代真实网页验证：

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
pnpm exec playwright test tests/e2e/screenshots.spec.ts --grep 首次配置界面
pnpm exec playwright test tests/e2e/widths.spec.ts --grep 'READY 视图在三种宽度下排版正确|LEARNING 视图在宽面板下排版正确'
cp test-results/widths/ready-560.png docs/images/panel-02-guide.png
cp test-results/widths/learning-720.png docs/images/panel-03-learning.png
```

README 的阅读与学习截图使用模拟内容，只展示当前界面。真实模型截图可单独用 `DEEPSEEK_KEY=... pnpm exec playwright test tests/e2e/screenshots.spec.ts --grep 首屏摘要与话题` 生成在 `test-results/live-screenshots/`，不会覆盖 README 图片。

## 权限边界

发布构建的 manifest 只声明：

- `permissions`: `storage`、`sidePanel`、`scripting`、`activeTab`
- `host_permissions`: `https://api.deepseek.com/*`
- `optional_host_permissions`: `https://*/*`、`http://*/*`（换页后从侧栏直接点击阅读入口、且工具栏的当前页临时授权已失效时，可能请求覆盖全部 HTTP(S) 网页的可选权限；再次点击工具栏可重新取得当前页 `activeTab` 权限，随后仍须点阅读入口才读正文）

没有 `tabs` 权限，也没有字面量 `<all_urls>`；但可选 host 权限实际覆盖全部 HTTP(S) 网站，不能将它描述为单站点授权。页面地址来自内容脚本上报与一次性工具栏点击，不靠 `tabs` 权限。

## 当前状态（2026-09-30，0.11.0）

- 当前代码内置 DeepSeek 与智谱官方接口；Key 各自存储，切换供应商会重新确认正文外发。两家都支持摘要、问答和「AI 问」。
- 模型设置把配置与实际使用分开，连接成功后才切换；具体模型与思考位于当前已连接服务的高级区。实测 `glm-4.6` 默认思考会占满最小连接测试的预算，现默认关闭，并保留「服务默认」选项。
- 两个模式采用对话流与底部输入区，保留草稿、回看位置和结束后的学习历史。AI 问首次主动进入就提出首问，一次一题，支持开放回答和单/多选卡片。图表预览直接打开独立大画布，支持指针缩放、平移、100%、缩略导航、全屏和返回来源。
- 短窗口下，长读取范围和错误提示可独立滚动，为输入操作保留空间。图表标签导航到其他页面后解除绑定，复用或清会话之前再次核对当前文档；旧上下文接口的身份回应也有打包浏览器回归。
- DeepSeek 会尝试转述一页最多 6 张内容图片，并披露未读范围；智谱不走视觉路径。内容图转述不能算作者原文，也不能作为图片为主页面的完整理解。
- 逐页阅读入口、正文提取、唯一锚点和 DOM 回跳有确定性测试与打包扩展 Chromium 回归；v0.9.7 修复了微信文章正文范围与回跳范围不一致的问题。
- 设置页可打开腾讯 ima 官网扫码查看，OpenAPI 列库与保存有源码原型；官网扫码不会授权扩展，侧栏保存尚未开放，也未用真实 ima 账号联调。
- 仍需桌面 Chrome 人工验证最大化窗口、原生权限弹窗与目标站点回跳，以及真实费用、错误注入、可访问性和普通读者价值。无头 Chromium 回归与模型成功输出不能替代这些验收，阶段门是否通过不能由发布版本号推断。

- 重连恢复网页订阅，后台重启后清理真正的孤儿 run；并发启动、取消清理和状态乱序有失败回归。引用快速投递、发送即从输入区消费，旧生成不会清掉新引用。读取范围不宣称全文百分比，起止内容可核对回跳。

## 已知限制

- 只正式支持 `http(s)` 上公开、有连续正文且用户有权外发的 HTML 页面；不支持登录态、PDF、视频、列表页与主要依赖图片的页面。
- 正文超过约 4.5 万字或 400 个块时直接阻断，不静默截断。
- 浏览器外壳界面（`chrome://extensions`、工具栏）无法自动化截图或点击，相关验证只能人工完成。
