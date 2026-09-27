import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test, type BrowserContext } from '@playwright/test';

/**
 * mermaid 在 MV3 下能不能真的画出图。
 *
 * 这一条只有在装好的扩展里跑才有意义：MV3 的 CSP 不允许 unsafe-eval，
 * 而图表库这类"把文本编译成图"的东西常常在内部用 new Function。
 * 打包体积检查发现不了它——构建照样成功，图在用户那里才画不出来。
 *
 * 逐类型验证：任何一类静默失败都会被这里抓到，而不是等用户看到「这张图没画出来」。
 *
 * 这一条要能启动的 Chromium。没有的时候（比如 WSL 缺 libnspr4）退到
 * tests/mermaid-csp.test.ts：那边用抛错的 eval / Function 桩模拟 CSP，不需要浏览器。
 */

const EXTENSION_PATH = resolve(process.cwd(), '.output/chrome-mv3-e2e');

/** 产品提示词里点名鼓励的那几种结构（流程、层级、因果、时序、对比）。 */
const DIAGRAMS: { name: string; source: string }[] = [
  { name: 'flowchart', source: 'flowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[执行]\n  B -->|否| D[结束]' },
  { name: 'sequence', source: 'sequenceDiagram\n  用户->>扩展: 提问\n  扩展->>模型: 正文+问题\n  模型-->>扩展: 回答' },
  { name: 'mindmap', source: 'mindmap\n  root((主题))\n    概念\n    前提\n    边界' },
  { name: 'stateDiagram', source: 'stateDiagram-v2\n  [*] --> 未开始\n  未开始 --> 进行中\n  进行中 --> [*]' },
  { name: 'classDiagram', source: 'classDiagram\n  class 文章\n  class 段落\n  文章 --> 段落' },
  { name: 'pie', source: 'pie title 构成\n  "原文" : 70\n  "补充" : 30' },
  { name: 'gantt', source: 'gantt\n  title 排期\n  section 阶段\n  设计 :a1, 2026-01-01, 7d' },
];

let context: BrowserContext;
let extensionId: string;

/** 构建产物的 chunk 名带内容哈希，每次构建都不同，所以按前缀找。 */
function mermaidChunk(): string {
  const dir = join(EXTENSION_PATH, 'chunks');
  const found = readdirSync(dir).find((name) => name.startsWith('mermaid.core-') && name.endsWith('.js'));
  if (!found) throw new Error('构建产物里没有 mermaid chunk：要么没装 mermaid，要么懒加载被内联进主包了');
  return `/chunks/${found}`;
}

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-diagram-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

test('mermaid 能在 MV3 的 CSP 下渲染各类图表', async () => {
  const page = await context.newPage();
  // 扩展内页面，跑在扩展自己的 CSP 下——这正是要验的环境。
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const cspErrors: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|unsafe-eval|EvalError/i.test(text)) cspErrors.push(text);
  });

  const results = await page.evaluate(
    async ({ sources, chunk }: { sources: { name: string; source: string }[]; chunk: string }) => {
      const { default: mermaid } = await import(chunk);
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'base' });
      const out: { name: string; ok: boolean; error?: string; hasSvg?: boolean }[] = [];
      for (const [index, item] of sources.entries()) {
        try {
          const { svg } = await mermaid.render(`probe-${index}`, item.source);
          out.push({ name: item.name, ok: true, hasSvg: svg.startsWith('<svg') });
        } catch (error) {
          out.push({ name: item.name, ok: false, error: String(error).slice(0, 200) });
        }
      }
      return out;
    },
    { sources: DIAGRAMS, chunk: mermaidChunk() },
  );

  // 失败的类型要点出名字，否则只知道"有一个挂了"，不知道该不该在提示词里禁掉它。
  const failed = results.filter((item) => !item.ok || item.hasSvg === false);
  expect(failed, `这些图表类型没画出来：${JSON.stringify(failed)}`).toEqual([]);
  expect(cspErrors, `出现了 CSP 报错：${cspErrors.join(' | ')}`).toEqual([]);
});
