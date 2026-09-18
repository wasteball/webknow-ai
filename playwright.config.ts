import { defineConfig } from '@playwright/test';

/**
 * 扩展端 E2E：必须用持久化上下文加载已构建的扩展（Playwright 官方要求）。
 * 用 `pnpm test:e2e` 跑（会先做 e2e 模式构建到 .output/chrome-mv3-e2e）。
 * 首次需要 `pnpm exec playwright install chromium`，以及系统的浏览器依赖库。
 */
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { channel: 'chromium' },
});
