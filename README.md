# 网页知识助手代码区

首个可运行切片是一条 HTML 证据闭环：

```text
站点按需授权 → 提取文章正文 → 完整短文问答
→ 逐主张引用校验 → 第二轮证据关系复核 → 点击回到原文
```

## 当前实现

- Chrome/Chromium Manifest V3 与 Side Panel；
- WXT + React + TypeScript；
- Readability 主体识别，不把清洗 HTML 注入侧栏；
- 段落、标题、列表项、表格单元 EvidenceBlock；
- 原位锚点、唯一上下文重定位和明确跳转失败；
- 图片存在性披露，不声称已理解图片；
- 提问前后复核正文与正文图片指纹，页面变化时丢弃旧答案；
- 标签页会话与模型凭证分离存储；
- DeepSeek 直连与 JSON 模式 Spike；
- 首次正文外发确认；
- 短资料全量上下文、两轮证据校验和长文阻断；
- 单元、组件、安全及扩展 E2E 测试。

本切片不包括 PDF、ima、OCR/VLM、长文分段扫描、自定义 Base URL、多供应商、Embedding、Skill 或产品后端。

## 开发命令

```bash
npm ci
npm run dev
npm run check
npm run e2e:install  # 首次运行 E2E 时执行一次
npm run test:e2e
npm run build
```

- `npm run check`：类型检查、Biome、单元/组件测试、生产构建和 Manifest 审计；
- `npm run test:e2e`：生成 `.output/chrome-mv3-test/` 测试构建，启动本机合成网页/模型服务，并运行 Playwright；
- `npm run build`：输出可手工加载的生产扩展到 `.output/chrome-mv3/`；测试构建不可作为交付物。

首次安装依赖时使用 `npm install` 生成 `package-lock.json`；此后使用 `npm ci`。Linux/WSL 若 Playwright 提示缺少 Chromium 动态库，先运行 `npx playwright install-deps chromium`（需要系统管理员权限），再执行 E2E。

## 手工加载

1. 运行 `npm run build`；
2. 打开 Chrome 的 `chrome://extensions`；
3. 启用开发者模式，选择“加载已解压的扩展程序”；
4. 选择本目录的 `.output/chrome-mv3/`；
5. 打开一篇普通 HTML 文章，点击扩展图标打开 Side Panel。

DeepSeek API Key 只保存在扩展的 `storage.local`，由 Background 读取。不要把真实 Key 写入源码、测试、终端参数、日志或问题报告。

## 权限边界

生产 Manifest 的固定权限只有：

- `activeTab`
- `scripting`
- `storage`
- `sidePanel`

网页与模型域名均为可选 host 权限，在用户点击后申请；侧栏可单独撤销当前站点权限。`scripts/audit-manifest.mjs` 会阻止生产构建携带 required host、测试地址、`<all_urls>` 或产品后端地址。

## 目录

```text
entrypoints/   # Background、Page Agent、Side Panel
src/           # 契约、提取、存储、模型和可信编排
tests/         # 单元、组件、合成 HTML 与扩展 E2E
scripts/       # 构建审计
public/        # 本地图标资源
```
