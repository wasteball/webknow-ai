import { defineConfig } from 'wxt';

// 权限边界（PRD FR-003/FR-019/FR-032）：
// - 不申请 tabs：页面身份来自内容脚本与写回前校验，避免“读取浏览历史”警告
// - 站点读取权限按需申请（optional_host_permissions + 用户手势中 request）
// - 唯一固定外发目标是 DeepSeek
//
// `--mode e2e` 只为端到端测试静态授予本地回环地址：授权弹窗是浏览器 UI，
// 无头环境无法点击。发布构建必须用默认模式，其 host_permissions 只有 DeepSeek。
const E2E_HOST_PERMISSION = 'http://127.0.0.1/*';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: (env) => ({
    name: 'webknow-ai',
    description: '在公开网页旁生成短摘要与探索气泡，支持自由提问和自愿的“AI 问我”',
    permissions: ['storage', 'sidePanel', 'scripting'],
    host_permissions:
      env.mode === 'e2e'
        ? ['https://api.deepseek.com/*', E2E_HOST_PERMISSION]
        : ['https://api.deepseek.com/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: {},
  }),
});
