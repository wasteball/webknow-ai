import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'https://example.test/article' } },
    setupFiles: ['./tests/setup.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
