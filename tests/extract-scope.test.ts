// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

const first = '这是提取器合并后的开头文字，保留内容但无法唯一对应网页中的段落。'.repeat(4);
const last = '这是提取器合并后的末尾文字，内容可以读取但不应提供一个假的回跳按钮。'.repeat(4);
vi.mock('@mozilla/readability', () => ({ Readability: class {
  parse() { return { title: '合并文章', content: `<article><p>${first}</p><p>${last}</p></article>` }; }
} }));
import { extractDocument } from '../src/content/extract';

it('保留无法定位的正文起止，并披露其不能回跳的状态', () => {
  document.body.innerHTML = '<article><p>页面原来的段落结构与提取后合并的段落不同。</p><p>另一段正文包含原来的阅读上下文。</p></article>';
  const value = extractDocument();
  expect(value.completeness.excludedBlocks).toBe(2);
  expect(value.completeness.textRange?.first.text).toContain('提取器合并后的开头');
  expect(value.completeness.textRange?.first.jumpable).toBe(false);
  expect(value.completeness.textRange?.last.jumpable).toBe(false);
});
