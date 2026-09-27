// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * mermaid 在 MV3 的 CSP 下能不能用。
 *
 * MV3 不允许 unsafe-eval，而「把文本编译成图」的库常常内部用 new Function。
 * 构建成功发现不了它——图只在用户那里画不出来。
 *
 * 这一条把 eval 和 Function 都换成抛错的桩：任何一类图只要碰了它们，
 * 解析就会失败并在这里点出名字。CSP 会做同样的事，只是那边报 EvalError。
 *
 * 为什么不在真浏览器里跑：tests/e2e/diagram.spec.ts 才是那条，需要能启动的
 * Chromium（本机 WSL 缺 libnspr4，整个 e2e 套件都跑不起来）。这一条不需要浏览器。
 */

/** 产品提示词里点名鼓励的那几种结构。 */
const DIAGRAMS: { name: string; source: string }[] = [
  { name: 'flowchart', source: 'flowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[执行]\n  B -->|否| D[结束]' },
  { name: 'sequence', source: 'sequenceDiagram\n  用户->>扩展: 提问\n  扩展->>模型: 正文+问题\n  模型-->>扩展: 回答' },
  { name: 'mindmap', source: 'mindmap\n  root((主题))\n    概念\n    前提\n    边界' },
  { name: 'stateDiagram', source: 'stateDiagram-v2\n  [*] --> 未开始\n  未开始 --> 进行中\n  进行中 --> [*]' },
  { name: 'classDiagram', source: 'classDiagram\n  class 文章\n  class 段落\n  文章 --> 段落' },
  { name: 'pie', source: 'pie title 构成\n  "原文" : 70\n  "补充" : 30' },
  { name: 'gantt', source: 'gantt\n  title 排期\n  section 阶段\n  设计 :a1, 2026-01-01, 7d' },
];

/** 被桩函数记下的每一次 eval / Function 调用，用于失败时说清是谁碰的。 */
const evalHits: string[] = [];
let mermaid: typeof import('mermaid').default;

beforeAll(async () => {
  const RealFunction = Function;
  // CSP 下这两个直接抛 EvalError，这里照抄这个行为。
  globalThis.eval = ((source: string) => {
    evalHits.push(`eval: ${String(source).slice(0, 60)}`);
    throw new Error('EvalError: call to eval() blocked by CSP');
  }) as typeof globalThis.eval;
  globalThis.Function = new Proxy(RealFunction, {
    apply: (_target, _self, args: unknown[]) => {
      evalHits.push(`Function(): ${String(args[0]).slice(0, 60)}`);
      throw new Error('EvalError: call to Function() blocked by CSP');
    },
    construct: (_target, args: unknown[]) => {
      evalHits.push(`new Function: ${String(args[0]).slice(0, 60)}`);
      throw new Error('EvalError: call to Function() blocked by CSP');
    },
  });

  ({ default: mermaid } = await import('mermaid'));
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'base' });
  // mermaid 是个几十兆的包，未打包地 import 一次要十几秒，默认 10s 的钩子超时不够。
}, 90_000);

describe('mermaid 在 MV3 的 CSP 下', () => {
  // 逐类型跑：一类静默失败要能看出是哪一类，才知道该不该在提示词里禁掉它。
  it.each(DIAGRAMS)('能解析 $name', async ({ source }) => {
    await expect(mermaid.parse(source)).resolves.toBeTruthy();
  });

  it('全程没有碰 eval 或 Function 构造器', () => {
    expect(evalHits, `mermaid 用到了 CSP 禁止的动态求值：${evalHits.join(' | ')}`).toEqual([]);
  });
});
