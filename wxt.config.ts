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
    description: '在公开网页旁生成短摘要与探索气泡，支持我问和问我',
    // activeTab：点工具栏图标时把当前标签页地址交给扩展（无安装警告、不读取浏览历史）。
    // 没有它就拿不到网址，也就不知道该向哪个网站申请读取权限——真实故障就是这样发生的。
    permissions: ['storage', 'sidePanel', 'scripting', 'activeTab'],
    host_permissions:
      env.mode === 'e2e'
        ? ['https://api.deepseek.com/*', E2E_HOST_PERMISSION]
        : ['https://api.deepseek.com/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // 工具栏图标必须显式声明：默认的灰色拼图块会让试用者认不出哪个是本插件。
    action: {
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
  }),
});
