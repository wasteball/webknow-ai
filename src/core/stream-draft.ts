import { omitBlockIds } from './validate';

/**
 * 从还没写完的模型 JSON 里抽出读者此刻能看的句子。
 *
 * 传输已经是 SSE，但整段仍是一个 JSON 对象：直接把分片画出来会露出花括号、
 * 引用数组和块编号。这里只取约定好的读者字段；引用、气泡、后续问题、
 * 选择题答案和理由都留到校验通过后再出现。
 */

/** 对象第一层的长文：问答、摘要、反馈、评析、讲解、提示、开放问题。 */
const DEPTH1_KEYS = new Set(['answer', 'summary', 'feedback', 'analysis', 'explanation', 'hint', 'question']);

/** 嵌在数组里、读者仍要看见的短句：题干、选项、逐题评语。 */
const NESTED_KEYS = new Set(['text', 'label', 'note']);

type Slice = { value: string; end: number; closed: boolean };

/** 读一个 JSON 字符串。末尾截断的转义先停住，避免界面闪一下反斜杠。 */
function readJsonString(buffer: string, quoteAt: number): Slice {
  let index = quoteAt + 1;
  let value = '';
  while (index < buffer.length) {
    const char = buffer[index]!;
    if (char === '\\') {
      if (index + 1 >= buffer.length) return { value, end: buffer.length, closed: false };
      const next = buffer[index + 1]!;
      if (next === 'u') {
        if (index + 6 > buffer.length) return { value, end: buffer.length, closed: false };
        const hex = buffer.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          value += next;
          index += 2;
          continue;
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      const simple: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
        '"': '"',
        '\\': '\\',
        '/': '/',
      };
      value += simple[next] ?? next;
      index += 2;
      continue;
    }
    if (char === '"') return { value, end: index + 1, closed: true };
    value += char;
    index += 1;
  }
  return { value, end: buffer.length, closed: false };
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

export function readerDraft(buffer: string): string {
  const start = buffer.indexOf('{');
  if (start < 0) return '';
  const parts: string[] = [];
  let index = start;
  let depth = 0;
  while (index < buffer.length) {
    const char = buffer[index]!;
    if (char === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (char === '[' || char === ']' || char === ':' || char === ',' || isSpace(char)) {
      index += 1;
      continue;
    }
    if (char !== '"') {
      index += 1;
      continue;
    }
    const token = readJsonString(buffer, index);
    if (!token.closed) break;
    let cursor = token.end;
    while (isSpace(buffer[cursor])) cursor += 1;
    if (buffer[cursor] === ':') {
      const key = token.value;
      cursor += 1;
      while (isSpace(buffer[cursor])) cursor += 1;
      const wanted = (depth === 1 && DEPTH1_KEYS.has(key)) || (depth >= 2 && NESTED_KEYS.has(key));
      if (wanted && buffer[cursor] === '"') {
        const value = readJsonString(buffer, cursor);
        if (value.value) parts.push(value.value);
        index = value.closed ? value.end : buffer.length;
        continue;
      }
    }
    index = token.end;
  }
  return parts.join('\n\n');
}

/** 送给界面之前再去掉已知块编号。编号表来自当前页，不从半截 JSON 里猜。 */
export function visibleDraft(buffer: string, blockIds: readonly string[]): string {
  const prose = readerDraft(buffer);
  if (!prose) return '';
  return omitBlockIds(prose, blockIds);
}

/** 思考过程是模型自己的话，不是 JSON。块编号同样不能出现在界面上。 */
export function presentReasoning(text: string, blockIds: readonly string[]): string {
  return omitBlockIds(text, blockIds);
}
