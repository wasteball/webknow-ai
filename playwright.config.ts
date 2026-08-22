import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: 'http://127.0.0.1:4173/article',
    reuseExistingServer: false,
    timeout: 10_000,
  },
  use: { trace: 'retain-on-failure' },
});
