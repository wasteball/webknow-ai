import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown, type Block, type Inline } from '../src/core/markdown';

/** 把 AST 里所有可见字符收集回来，用于「永不丢字」不变量。 */
function visibleText(blocks: Block[]): string {
  const fromInline = (nodes: Inline[]): string =>
    nodes
      .map((node) => (node.t === 'text' || node.t === 'strong' || node.t === 'code' ? node.v : node.alt))
      .join('');
  return blocks
    .map((block) => {
      switch (block.t) {
        case 'p':
        case 'h':
          return fromInline(block.v);
        case 'ul':
          return block.items.map((item) => fromInline(item.v) + (item.sub ? visibleText(item.sub) : '')).join('');
        // 有序列表的编号会被渲染出来，所以它算可见内容。
        case 'ol':
          return block.items
            .map((item, index) => `${index + 1}.${fromInline(item.v)}${item.sub ? visibleText(item.sub) : ''}`)
            .join('');
        case 'quote':
          return visibleText(block.v);
        // 代码块的语言标记会显示在代码块上。
        case 'code':
          return block.lang + block.v;
        case 'diagram':
        case 'diagram-raw':
          return block.source;
        case 'table':
          return [...block.head.map(fromInline), ...block.rows.flatMap((row) => row.map(fromInline))].join('');
      }
    })
    .join('');
}

/** 去掉空白与 markdown 标记后比较：解析器允许丢标记，不允许丢内容。 */
const meat = (text: string) => text.replace(/[\s*`#>|_[\]()!-]/g, '');

describe('不变量 1：永不丢字', () => {
  const samples = [
    '普通一段话。',
    '### 标题\n\n正文**加粗**与`代码`。',
    '- 第一项\n- 第二项\n  - 嵌套项',
    '1. 甲\n2. 乙',
    '> 引用里的话\n> 还有一行',
    '| 列一 | 列二 |\n|---|---|\n| 甲 | 乙 |',
    '```js\nconst a = 1;\n```',
    '未闭合的**粗体和未闭合的`代码',
    '```\n没有收尾的代码块',
    '|残缺表格没有分隔行|',
  ];

  for (const sample of samples) {
    it(`保留全部内容：${sample.slice(0, 16)}`, () => {
      expect(meat(visibleText(parseMarkdown(sample)))).toBe(meat(sample));
    });
  }
});

describe('不变量 2：注入样本原样成文', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[点我](javascript:alert(1))',
    '<iframe src="https://evil.example"></iframe>',
    '<div onclick="steal()">看似正常的文字</div>',
  ];

  for (const attack of attacks) {
    it(`成为可见文字：${attack.slice(0, 24)}`, () => {
      const blocks = parseMarkdown(attack);
      // 只允许产生 text 节点：没有任何结构化节点能承载脚本。
      const kinds = new Set(
        blocks.flatMap((block) => (block.t === 'p' ? block.v.map((node) => node.t) : [block.t])),
      );
      expect([...kinds]).toEqual(['text']);
      expect(visibleText(blocks)).toContain(attack.slice(0, 10));
    });
  }
});

describe('不变量 3：只接受 img:<id>', () => {
  it('img:id 产生图片节点', () => {
    const nodes = parseInline('看这张 ![流程](img:i_3) 图');
    expect(nodes).toContainEqual({ t: 'img', id: 'i_3', alt: '流程' });
  });

  for (const url of ['https://evil.example/x.png', 'data:image/png;base64,AAAA', '//evil.example/x.png', 'http://a.b/c.png?q=leak']) {
    it(`拒绝并降级：${url.slice(0, 28)}`, () => {
      const nodes = parseInline(`![alt](${url})`);
      expect(nodes.every((node) => node.t === 'text')).toBe(true);
      expect(nodes.map((node) => (node.t === 'text' ? node.v : '')).join('')).toContain(url);
    });
  }
});

describe('不变量 4：格式错乱不崩', () => {
  it('未闭合代码块降级为文字，不吞掉后续正文', () => {
    const blocks = parseMarkdown('```js\n没有收尾\n还有重要的一句');
    expect(visibleText(blocks)).toContain('还有重要的一句');
  });

  it('缺分隔行的表格不当表格', () => {
    const blocks = parseMarkdown('| 甲 | 乙 |\n| 丙 | 丁 |');
    expect(blocks.every((block) => block.t !== 'table')).toBe(true);
  });

  it('空输入返回空数组', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});

describe('结构解析', () => {
  it('# 与 ## 都降到 h3，### 之后降到 h4', () => {
    expect(parseMarkdown('# 一级')[0]).toMatchObject({ t: 'h', level: 3 });
    expect(parseMarkdown('#### 四级')[0]).toMatchObject({ t: 'h', level: 4 });
  });

  it('表格取表头与数据行', () => {
    const block = parseMarkdown('| 列一 | 列二 |\n|---|---|\n| 甲 | 乙 |\n| 丙 | 丁 |')[0]!;
    expect(block).toMatchObject({ t: 'table' });
    if (block.t === 'table') {
      expect(block.head).toHaveLength(2);
      expect(block.rows).toHaveLength(2);
    }
  });

  it('列表支持一层嵌套', () => {
    const block = parseMarkdown('- 外层\n  - 内层')[0]!;
    expect(block.t).toBe('ul');
    if (block.t === 'ul') expect(block.items[0]?.sub?.[0]?.t).toBe('ul');
  });
});

describe('图表块与预算护栏', () => {
  it('mermaid 块产生 diagram 节点', () => {
    const block = parseMarkdown('```mermaid\nflowchart TD\nA-->B\n```')[0]!;
    expect(block).toMatchObject({ t: 'diagram' });
  });

  it('允许结束围栏带尾部空格，并保留图后的正文', () => {
    const blocks = parseMarkdown('先看过程。\n```mermaid\nflowchart TD\nA-->B\n```   \n图下还有说明。');
    expect(blocks.map((block) => block.t)).toEqual(['p', 'diagram', 'p']);
    expect(blocks[1]).toMatchObject({ source: 'flowchart TD\nA-->B' });
    expect(visibleText(blocks)).toContain('图下还有说明。');
  });

  it('缩进的开闭围栏都能识别，后续正文不被吞掉', () => {
    const blocks = parseMarkdown('先看过程。\n  ```mermaid\nmindmap\n  root((主题))\n    子主题\n  ```   \n图下还有说明。');
    expect(blocks.map((block) => block.t)).toEqual(['p', 'diagram', 'p']);
    expect(blocks[1]).toMatchObject({ source: 'mindmap\n  root((主题))\n    子主题' });
  });

  it('明确围住且有语句分隔符的单行 Mermaid 能画，普通行内文字仍是文字', () => {
    const blocks = parseMarkdown('说明。\n```mermaid flowchart TD; A-->B; ```\n图下还有说明。');
    expect(blocks.map((block) => block.t)).toEqual(['p', 'diagram', 'p']);
    expect(blocks[1]).toMatchObject({ source: 'flowchart TD; A-->B;' });
    expect(parseMarkdown('这段 mermaid flowchart TD A-->B 只是普通文字')[0]?.t).toBe('p');
  });

  it('关掉图表时降级为普通代码块', () => {
    const block = parseMarkdown('```mermaid\nflowchart TD\nA-->B\n```', { diagrams: false })[0]!;
    expect(block).toMatchObject({ t: 'code', lang: 'mermaid' });
  });

  it('单行围栏过长时仍执行图表预算，不把任意行内 Mermaid 当作图', () => {
    const long = `\`\`\`mermaid flowchart TD; ${'A-->B; '.repeat(400)}\`\`\``;
    expect(parseMarkdown(long)[0]).toMatchObject({ t: 'diagram-raw' });
    expect(parseMarkdown('我想知道 `mermaid flowchart TD A-->B` 的含义')[0]?.t).toBe('p');
  });

  it('单行 Mermaid 关掉图表时仍显示源码，不识别未闭合围栏为图', () => {
    const text = '```mermaid flowchart TD; A-->B; ```';
    expect(parseMarkdown(text, { diagrams: false })[0]).toMatchObject({ t: 'code', lang: 'mermaid' });
    expect(parseMarkdown('```mermaid flowchart TD; A-->B;')[0]?.t).toBe('p');
  });

  it('单行 Mermaid 的语句数超限时不送去渲染', () => {
    const statements = Array.from({ length: 61 }, (_, index) => `A${index}-->B${index}`).join('; ');
    const block = parseMarkdown(`\`\`\`mermaid flowchart TD; ${statements}; \`\`\``)[0];
    expect(block).toMatchObject({ t: 'diagram-raw', reason: '这张图的内容太多了，没有画出来。' });
  });

  it('源码超长降级并说明原因', () => {
    const long = 'A-->B\n'.repeat(400);
    const block = parseMarkdown(`\`\`\`mermaid\n${long}\`\`\``)[0]!;
    expect(block.t).toBe('diagram-raw');
  });

  it('行数超限降级并说明原因', () => {
    const many = Array.from({ length: 80 }, (_, index) => `A${index}-->B${index}`).join('\n');
    const block = parseMarkdown(`\`\`\`mermaid\n${many}\n\`\`\``)[0]!;
    expect(block.t).toBe('diagram-raw');
    if (block.t === 'diagram-raw') expect(block.reason).toBeTruthy();
  });
});
