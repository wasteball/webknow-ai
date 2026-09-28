/**
 * 受控 Markdown 子集 → AST。
 *
 * 为什么自己写而不用 marked + DOMPurify：模型输出是不可信数据（FR-034）。
 * 走 HTML 字符串就必须引入净化器，净化器从此成为安全关键组件，漏一条规则就是 XSS。
 * 这里只产出数据节点，由 React 渲染成元素（FR-037），**全程不存在 HTML 字符串**，
 * 因此不需要净化器：白名单之外的一切都降级为可见文字。
 *
 * 不变量（见 markdown.test.ts）：
 * 1. 永不丢字：输入的所有可见字符都出现在输出的某个节点里。
 * 2. 注入样本原样成文：<script>、onerror=、javascript: 一律成为 text 节点。
 * 3. 只接受 ![](img:<id>)：任何 http/data/协议相对的图片链接都降级为 text。
 * 4. 格式错乱不崩：未闭合标记、残缺表格、未闭合代码块都降级为段落。
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'code'; v: string }
  | { t: 'img'; id: string; alt: string };

export type ListItem = { v: Inline[]; sub?: Block[] };

export type Block =
  | { t: 'p'; v: Inline[] }
  /** # 与 ## 一律降到 3：气泡里不该出现比模式标题更大的字。 */
  | { t: 'h'; level: 3 | 4; v: Inline[] }
  | { t: 'ul'; items: ListItem[] }
  | { t: 'ol'; items: ListItem[] }
  | { t: 'quote'; v: Block[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  /** ```mermaid 专走这条；只在 opts.diagrams 为真时产生。 */
  | { t: 'diagram'; source: string }
  /** 越界或不渲染的图表：显示为代码块并说明原因，不静默丢失。 */
  | { t: 'diagram-raw'; source: string; reason: string };

export type ParseOptions = {
  /** 用户设置「不要图」时为 false：mermaid 块降级为普通代码块。 */
  diagrams: boolean;
};

/** 图表预算护栏：与 LIMITS 同类，是成本与稳定性边界，不是内容规则。 */
export const DIAGRAM_LIMITS = {
  maxSourceChars: 2_000,
  /** 粗略节点计数：按非空行数估算，够用来挡住失控的大图。 */
  maxLines: 60,
} as const;

const IMG = /!\[([^\]]*)\]\(img:([A-Za-z0-9_-]+)\)/;
const STRONG = /\*\*([^*]+)\*\*/;
const CODE = /`([^`]+)`/;

/**
 * 行内解析：只认 ![](img:id)、**粗体**、`代码`。
 * 每轮取最靠左的一个标记，其余原样进 text —— 这保证了「永不丢字」。
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;

  while (rest) {
    const img = IMG.exec(rest);
    const strong = STRONG.exec(rest);
    const code = CODE.exec(rest);
    const candidates = [
      img ? { at: img.index, len: img[0].length, node: { t: 'img' as const, id: img[2] ?? '', alt: img[1] ?? '' } } : null,
      strong ? { at: strong.index, len: strong[0].length, node: { t: 'strong' as const, v: strong[1] ?? '' } } : null,
      code ? { at: code.index, len: code[0].length, node: { t: 'code' as const, v: code[1] ?? '' } } : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null);

    if (!candidates.length) break;
    const first = candidates.reduce((best, item) => (item.at < best.at ? item : best));
    if (first.at > 0) out.push({ t: 'text', v: rest.slice(0, first.at) });
    out.push(first.node);
    rest = rest.slice(first.at + first.len);
  }

  if (rest) out.push({ t: 'text', v: rest });
  return out.length ? out : [{ t: 'text', v: '' }];
}

/** 表格行 `| a | b |` → 单元格文本；不是表格行时返回 null。 */
function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((cell) => cell.trim());
}

const DIVIDER = /^[\s|:-]+$/;

/** 分隔行 `|---|:--:|`：判定「上一行确实是表头」的唯一依据。 */
function isDivider(line: string): boolean {
  const cells = splitRow(line);
  return cells !== null && cells.length > 0 && DIVIDER.test(line) && line.includes('-');
}

type ListMark = { ordered: boolean; text: string; indent: number };

const UL = /^(\s*)[-*]\s+(.*)$/;
const OL = /^(\s*)\d+[.)]\s+(.*)$/;

function listMark(line: string): ListMark | null {
  const ul = UL.exec(line);
  if (ul) return { ordered: false, indent: (ul[1] ?? '').length, text: ul[2] ?? '' };
  const ol = OL.exec(line);
  if (ol) return { ordered: true, indent: (ol[1] ?? '').length, text: ol[2] ?? '' };
  return null;
}

function diagramBlock(source: string, opts: ParseOptions): Block {
  if (!opts.diagrams) return { t: 'code', lang: 'mermaid', v: source };
  if (source.length > DIAGRAM_LIMITS.maxSourceChars) {
    return { t: 'diagram-raw', source, reason: '这张图太复杂了，没有画出来。' };
  }
  const lines = source.split(/[;\n]/).filter((line) => line.trim()).length;
  if (lines > DIAGRAM_LIMITS.maxLines) {
    return { t: 'diagram-raw', source, reason: '这张图的内容太多了，没有画出来。' };
  }
  return { t: 'diagram', source };
}

export function parseMarkdown(text: string, opts: ParseOptions = { diagrams: true }): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (!paragraph.length) return;
    blocks.push({ t: 'p', v: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }

    // 代码块（含 mermaid）。未闭合时把 ``` 与其后内容当普通文字，不吞掉正文。
    const trimmed = line.trim();
    const single = /^```mermaid\s+([^`]+?)\s+```$/i.exec(trimmed);
    if (single) {
      flush();
      blocks.push(diagramBlock(single[1] ?? '', opts));
      index += 1;
      continue;
    }
    const fence = /^```(\w*)[ \t]*$/.exec(trimmed);
    if (fence) {
      const close = lines.findIndex((candidate, at) => at > index && /^```[ \t]*$/.test(candidate.trim()));
      if (close === -1) {
        paragraph.push(line);
        index += 1;
        continue;
      }
      flush();
      const source = lines.slice(index + 1, close).join('\n');
      const lang = (fence[1] ?? '').toLowerCase();
      blocks.push(lang === 'mermaid' ? diagramBlock(source, opts) : { t: 'code', lang, v: source });
      index = close + 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ t: 'h', level: (heading[1] ?? '').length <= 3 ? 3 : 4, v: parseInline(heading[2] ?? '') });
      index += 1;
      continue;
    }

    // 引用：连续的 > 行，内容递归解析（可含列表、代码块）。
    if (/^>\s?/.test(line)) {
      flush();
      const inner: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        inner.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ t: 'quote', v: parseMarkdown(inner.join('\n'), opts) });
      continue;
    }

    // 表格：必须「表头行 + 分隔行」齐备才算，否则按普通文字走。
    const head = splitRow(line);
    if (head && index + 1 < lines.length && isDivider(lines[index + 1] ?? '')) {
      flush();
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length) {
        const cells = splitRow(lines[index] ?? '');
        if (!cells) break;
        rows.push(cells.map(parseInline));
        index += 1;
      }
      blocks.push({ t: 'table', head: head.map(parseInline), rows });
      continue;
    }

    const mark = listMark(line);
    if (mark) {
      flush();
      const baseIndent = mark.indent;
      const ordered = mark.ordered;
      const items: ListItem[] = [];
      while (index < lines.length) {
        const current = listMark(lines[index] ?? '');
        if (!current || current.ordered !== ordered || current.indent < baseIndent) break;
        if (current.indent > baseIndent) {
          // 嵌套一层：收集所有更深缩进的行，递归解析后挂到上一项下面。
          const nested: string[] = [];
          while (index < lines.length) {
            const deeper = listMark(lines[index] ?? '');
            if (!deeper || deeper.indent <= baseIndent) break;
            nested.push((lines[index] ?? '').slice(baseIndent + 1));
            index += 1;
          }
          const last = items[items.length - 1];
          if (last) last.sub = parseMarkdown(nested.join('\n'), opts);
          else items.push({ v: parseInline(nested.join(' ')) });
          continue;
        }
        items.push({ v: parseInline(current.text) });
        index += 1;
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', items });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flush();
  return blocks;
}

/** 这段文本里有没有图表：界面据此决定是否需要懒加载渲染器。 */
export function hasDiagram(blocks: Block[]): boolean {
  return blocks.some((block) => block.t === 'diagram' || (block.t === 'quote' && hasDiagram(block.v)));
}
