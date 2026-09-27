// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.fn(() => Promise.resolve());

vi.stubGlobal('browser', { runtime: { sendMessage } });

const { startQuoteAsk } = await import('../src/content/select');

function selectParagraph(): void {
  const paragraph = document.querySelector('p');
  if (!paragraph) throw new Error('缺少段落');
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function quoteButton(): HTMLButtonElement | null {
  const host = document.getElementById('wka-quote-ask');
  return host?.shadowRoot?.querySelector('button') ?? null;
}

describe('划词提问按钮', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    document.documentElement.innerHTML =
      '<body><p>市政府今天公布了新的公交线路调整方案，从下周一开始试行。</p></body>';
    Range.prototype.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 40,
        top: 40,
        left: 10,
        right: 200,
        bottom: 64,
        width: 190,
        height: 24,
        toJSON() {
          return this;
        },
      }) as DOMRect;
    const scope = globalThis as typeof globalThis & { __wkaQuoteAsk?: boolean; __wkaSkipQuoteUp?: number };
    delete scope.__wkaQuoteAsk;
    scope.__wkaSkipQuoteUp = 0;
    startQuoteAsk();
  });

  afterEach(() => {
    document.getElementById('wka-quote-ask')?.remove();
  });

  it('划完一段会出现问这句', () => {
    selectParagraph();
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(quoteButton()?.textContent).toBe('问这句');
  });

  it('点问这句在 mousedown 就发出划词；随后的 mouseup 不能把这次点击吃掉', () => {
    selectParagraph();
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const button = quoteButton();
    expect(button).toBeTruthy();
    // 真实顺序：mousedown →（窗口 mouseup 若重建按钮则 click 打不到原按钮）
    button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'quoteSelected',
      text: expect.stringContaining('公交线路调整方案'),
    });
  });

  it('超过八百字仍然给出问这句，发出去的是裁过的原文', () => {
    document.body.innerHTML = `<p>${'甲'.repeat(900)}</p>`;
    selectParagraph();
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(quoteButton()?.textContent).toBe('问这句');
    quoteButton()?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'quoteSelected',
      text: `${'甲'.repeat(500)}…`,
    });
  });

  it('刚出现时页面滚动不会把按钮立刻收掉', () => {
    selectParagraph();
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    window.dispatchEvent(new Event('scroll'));
    expect(quoteButton()?.textContent).toBe('问这句');
  });

  it('给正文加上可选中样式，压过页面的禁止选择', () => {
    expect(document.getElementById('wka-quote-select')?.textContent).toContain('user-select:text');
  });

  it('页面在冒泡阶段清掉选区之前，捕获阶段已经看见这段话', () => {
    const paragraph = document.querySelector('p');
    if (!paragraph) throw new Error('缺少段落');
    paragraph.addEventListener('mouseup', () => window.getSelection()?.removeAllRanges());
    selectParagraph();
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(quoteButton()?.textContent).toBe('问这句');
  });
});
