import { defineConfig } from 'wxt';

// 权限边界（PRD FR-003/FR-019/FR-032）：
// - 不申请 tabs：页面身份来自内容脚本与写回前校验，避免“读取浏览历史”警告
// - 站点读取权限按需申请（optional_host_permissions + 用户手势中 request）
// - 唯一固定外发目标是 DeepSeek
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'webknow-ai',
    description: '在公开网页旁生成短摘要与探索气泡，支持自由提问和自愿的“AI 问我”',
    permissions: ['storage', 'sidePanel', 'scripting'],
    host_permissions: ['https://api.deepseek.com/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: {},
  },
});
