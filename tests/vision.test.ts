import { describe, expect, it } from 'vitest';

import type { Completeness, EvidenceBlock, PictureRef } from '../src/core/blocks';
import { describeCompleteness } from '../src/core/blocks';
import { applyImageReadings, visionBody, visionTextFrom } from '../src/core/vision';

function block(id: string): EvidenceBlock {
  return {
    id,
    role: 'paragraph',
    content: `段落 ${id}`,
    headingPath: [],
    anchor: {
      sessionAnchorId: id,
      selector: 'p',
      exact: `段落 ${id}`,
      prefix: '',
      suffix: '',
      headingPath: [],
      fingerprint: 'f',
    },
  };
}

function picture(id: string, afterBlockId?: string): PictureRef {
  return {
    id,
    url: `https://example.com/${id}.png`,
    alt: '',
    afterBlockId,
    anchor: {
      sessionAnchorId: id,
      selector: 'img',
      exact: `image:${id}`,
      prefix: '',
      suffix: '',
      headingPath: [],
      fingerprint: 'f',
    },
  };
}

const completeness: Completeness = {
  scope: 'readability-article',
  text: { status: 'parsed', found: 1, captured: 1 },
  tables: { status: 'not-present', found: 0, captured: 0 },
  images: { status: 'unavailable', found: 2, captured: 0 },
  frames: { status: 'not-present', found: 0, captured: 0 },
  excludedBlocks: 0,
  truncated: false,
  warnings: [],
};

describe('读图', () => {
  it('请求关掉思考，并且不使用 JSON 模式', () => {
    const body = visionBody('data:image/jpeg;base64,aa');
    expect(body.model).toBe('deepseek-v4-flash-vision-exp');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.stream).toBe(false);
    expect(JSON.stringify(body)).not.toContain('json_object');
  });

  it('从响应里取出转述，空响应不当成读到了', () => {
    expect(visionTextFrom({ choices: [{ message: { content: ' 图上写着你好 ' } }] })).toBe('图上写着你好');
    expect(visionTextFrom({})).toBe('');
  });

  it('按阅读顺序插入转述，看不清的图不编内容', () => {
    const applied = applyImageReadings(
      [block('b_0')],
      [picture('img_0', 'b_0'), picture('img_1', 'b_0')],
      [
        { id: 'img_0', text: '封面标题是看见灵感' },
        { id: 'img_1', text: '看不清' },
      ],
      completeness,
    );
    expect(applied.blocks.map((item) => item.id)).toEqual(['b_0', 'img_0']);
    expect(applied.blocks[1]?.content).toContain('可能有误');
    expect(applied.blocks[1]?.content).toContain('看见灵感');
    expect(applied.completeness.images).toEqual({ status: 'partial', found: 2, captured: 1 });
    expect(describeCompleteness(applied.completeness)).toContain('并非作者原话');
    expect(describeCompleteness(applied.completeness)).toContain('1 张图片未读');
  });
});
