import { defineConfig } from 'wxt';

// 权限边界（PRD FR-003/FR-019/FR-032）：
// - 不申请 tabs：页面身份来自内容脚本与写回前校验，避免“读取浏览历史”警告
// - 打开侧栏靠工具栏点击（activeTab）。换页后点「总结摘要」等按钮时，
//   若这次点击的读取权已经失效，才申请 optional host，且只在点击时读
// - optional_host_permissions 留给搜索 / IMA / 智谱，由对应设置里按需申请
// - 唯一固定外发目标是 DeepSeek
//
// `--mode e2e` 为端到端测试静态授予本地回环地址、智谱及测试使用的精确搜索 API 来源：授权弹窗是浏览器 UI，
// 无头环境无法点击。发布构建必须用默认模式，其 host_permissions 只有 DeepSeek。
const E2E_HOST_PERMISSION = 'http://127.0.0.1/*';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: (env) => ({
    name: 'WebKnow AI',
    description: '在公开文章旁提供短摘要和探索话题，支持向 AI 提问或让 AI 提问；需自备模型 API Key。',
    // activeTab：点工具栏图标时把当前标签页地址交给扩展（无安装警告、不读取浏览历史）。
    // 没有它就拿不到网址，也就不知道该向哪个网站申请读取权限——真实故障就是这样发生的。
    // contextMenus：右键“问 WebKnow AI”（划词兜底），安装时没有额外警告。
    permissions: ['storage', 'sidePanel', 'scripting', 'activeTab', 'contextMenus'],
    host_permissions:
      env.mode === 'e2e'
        ? ['https://api.deepseek.com/*', 'https://open.bigmodel.cn/*', E2E_HOST_PERMISSION, 'https://api.bochaai.com/*', 'https://api.firecrawl.dev/*']
        : ['https://api.deepseek.com/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // 页内浮层：网页里的 iframe 装的就是面板页本身。只有面板页允许被网页加载；
    // 网页脚本只能把它嵌进来，读不到里面的内容（跨源）。use_dynamic_url 防止网站探测是否装了本扩展。
    web_accessible_resources: [{
      resources: ['sidepanel.html'],
      matches: ['https://*/*', 'http://*/*'],
      use_dynamic_url: true,
    }],
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
