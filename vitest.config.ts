import { defineConfig } from 'vitest/config';

// core/ 是纯逻辑（无 chrome.*、无 DOM 依赖），因此默认环境用 node。
// 需要 DOM 的用例在文件顶部用 `// @vitest-environment jsdom` 单独声明。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
