import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  manifest: ({ mode }) => ({
    name: '网页知识助手',
    description: '对网页提问，核查原始证据，并回到原文。',
    permissions: ['activeTab', 'scripting', 'storage', 'sidePanel'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    ...(mode === 'test' ? { host_permissions: ['http://127.0.0.1:4173/*'] } : {}),
    action: { default_title: '打开网页知识助手' },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  }),
});
