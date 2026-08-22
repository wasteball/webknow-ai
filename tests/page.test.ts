import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureDocument, documentFingerprint, jumpToAnchor } from '../src/page';

const article = `
  <article>
    <h1>研究报告</h1>
    <h2>主要发现</h2>
    <p>研究显示，方案甲在常规工作负载下平均减少了百分之二十的处理时间。</p>
    <p>这一结果只在样本中的三个团队和四周观察期内成立，不能直接外推到全部组织。</p>
    <ul><li>参与团队均已接受过工具培训，可能放大短期效果。</li></ul>
    <table><caption>处理时间</caption><thead><tr><th>方案</th><th>分钟</th></tr></thead><tbody><tr><th>甲</th><td>八十</td></tr><tr><th>乙</th><td>一百</td></tr></tbody></table>
    <img src="chart.png" alt="性能图表" />
  </article>`;

function install(html: string) {
  document.documentElement.innerHTML = `<head><title>合成研究</title></head><body>${html}</body>`;
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
}

describe('HTML evidence capture', () => {
  beforeEach(() => install(article));

  it('captures anchored text and discloses unparsed images', () => {
    const result = captureDocument('session-a');
    if (!result.ok) throw new Error(result.error.message);
    expect(result.blocks.some((block) => block.role === 'paragraph')).toBe(true);
    expect(result.blocks.some((block) => block.role === 'table-cell')).toBe(true);
    expect(result.blocks.every((block) => block.sourceLevel === 'L1')).toBe(true);
    expect(result.completeness.images.status).toBe('unavailable');
    expect(result.state).toBe('READY_PARTIAL');
  });

  it('jumps only when the original anchored text still matches', () => {
    const result = captureDocument('session-b');
    if (!result.ok) throw new Error(result.error.message);
    const paragraph = result.blocks.find((block) => block.role === 'paragraph');
    expect(paragraph).toBeDefined();
    if (!paragraph) throw new Error('Missing captured paragraph');
    expect(jumpToAnchor(paragraph.anchor).outcome).toBe('jumped');
    const target = document.querySelector(
      `[data-wka-anchor="${paragraph.anchor.sessionAnchorId}"]`,
    );
    if (!target) throw new Error('Missing source anchor');
    target.textContent = '内容已变化';
    expect(jumpToAnchor(paragraph.anchor).outcome).toBe('failed');
  });

  it('does not relocate to the wrong copy of repeated text', () => {
    install(`
      <article><h1>重复文本测试</h1><h2>甲</h2>
      <p>完全相同的证据句子用于验证歧义定位，不能随便跳到其中任何一个副本。</p>
      <h2>乙</h2><p>完全相同的证据句子用于验证歧义定位，不能随便跳到其中任何一个副本。</p>
      <p>另一个段落提供足够长度，使正文识别能稳定完成并建立文章主体。</p></article>
    `);
    const result = captureDocument('session-c');
    if (!result.ok) throw new Error(result.error.message);
    const repeated = result.blocks.find((block) => block.context.headingPath.includes('甲'));
    expect(repeated).toBeDefined();
    if (!repeated) throw new Error('Missing repeated evidence block');
    document.querySelectorAll('[data-wka-anchor]').forEach((element) => {
      element.removeAttribute('data-wka-anchor');
    });
    const articleElement = document.querySelector('article');
    if (!articleElement) throw new Error('Missing test article');
    const exact = repeated.anchor.exact;
    articleElement.innerHTML = `
      <h1>重复文本测试</h1>
      <h2>甲</h2><p>${exact}</p><p>相同的相邻说明。</p>
      <h2>甲</h2><p>${exact}</p><p>相同的相邻说明。</p>`;
    expect(
      jumpToAnchor({
        ...repeated.anchor,
        selector: 'not a valid[',
        headingPath: ['重复文本测试', '甲'],
        prefix: '甲',
        suffix: '相同的相邻说明。',
      }).outcome,
    ).toBe('failed');
  });

  it('rejects pages without enough uniquely anchored article text', () => {
    install('<main><p>太短。</p></main>');
    const result = captureDocument('session-d');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PARSE_FAILED');
  });
  it('changes the document fingerprint when an in-scope image changes', () => {
    const result = captureDocument('session-image');
    if (!result.ok) throw new Error(result.error.message);
    const image = document.querySelector('article img');
    if (!(image instanceof HTMLImageElement)) throw new Error('Missing test image');
    const before = documentFingerprint();
    image.alt = '更新后的性能图表';
    const afterAlt = documentFingerprint();
    expect(afterAlt).not.toBe(before);
    image.src = '/updated-chart.png';
    const afterSource = documentFingerprint();
    expect(afterSource).not.toBe(afterAlt);
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<nav><img src="outside-ad.png" alt="正文外广告"></nav>',
    );
    expect(documentFingerprint()).toBe(afterSource);
    document
      .querySelector('article')
      ?.insertAdjacentHTML(
        'beforeend',
        '<p>运行期间新增的正文证据也必须使当前会话失效，不能继续沿用旧回答。</p><img src="new-chart.png" alt="新增图表">',
      );
    expect(documentFingerprint()).not.toBe(afterSource);
  });
});
