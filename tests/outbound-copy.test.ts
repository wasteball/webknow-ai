import { describe, expect, it } from 'vitest';

import { outboundConfirmedHint, outboundFeeLine, outboundRetentionLine } from '../src/sidepanel/outbound-copy';

/**
 * 这些句子会进首次外发告知。哪家供应商的名字写死成 DeepSeek，
 * 选了智谱的用户就会去错的地方查账、也搞不清正文发给了谁。
 */
describe('外发告知文案跟着当前供应商走', () => {
  it('智谱路径里不出现 DeepSeek', () => {
    expect(outboundFeeLine('智谱')).toBe('费用从你自己的智谱账号里扣。');
    expect(outboundRetentionLine('智谱')).toContain('智谱');
    expect(outboundRetentionLine('智谱')).not.toContain('DeepSeek');
    expect(outboundConfirmedHint('智谱（Zhipu）')).toContain('智谱（Zhipu）');
    expect(outboundConfirmedHint('智谱（Zhipu）')).not.toContain('DeepSeek');
  });

  it('DeepSeek 路径仍然说清接收方', () => {
    expect(outboundFeeLine('DeepSeek')).toContain('DeepSeek');
    expect(outboundRetentionLine('DeepSeek')).toContain('DeepSeek');
    expect(outboundConfirmedHint('DeepSeek（深度求索）')).toContain('DeepSeek（深度求索）');
  });
});
