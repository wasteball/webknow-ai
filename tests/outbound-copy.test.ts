import { panel } from './helpers/panel';
import { describe, expect, it } from 'vitest';

import { outboundReceiverLines, outboundConfirmedHint, outboundFeeLine, outboundRetentionLine } from '../src/sidepanel/outbound-copy';

/**
 * 这些句子会进首次外发告知。哪家供应商的名字写死成 DeepSeek，
 * 选了智谱的用户就会去错的地方查账、也搞不清正文发给了谁。
 */
describe('外发告知文案跟着当前供应商走', () => {
  it('智谱路径里不出现 DeepSeek', () => {
    expect(outboundFeeLine('智谱')).toBe('费用从你自己的智谱账号里扣。');
    expect(outboundRetentionLine('智谱')).toContain('智谱');
    expect(outboundRetentionLine('智谱')).not.toContain('DeepSeek');
    expect(outboundConfirmedHint('智谱（Zhipu）', false)).toContain('智谱（Zhipu）');
    expect(outboundConfirmedHint('智谱（Zhipu）', false)).not.toContain('DeepSeek');
    expect(outboundConfirmedHint('智谱（Zhipu）', false)).not.toContain('图片');
  });

  it('DeepSeek 路径仍然说清接收方', () => {
    expect(outboundFeeLine('DeepSeek')).toContain('DeepSeek');
    expect(outboundRetentionLine('DeepSeek')).toContain('DeepSeek');
    expect(outboundConfirmedHint('DeepSeek（深度求索）', true)).toContain('DeepSeek（深度求索）');
    expect(outboundConfirmedHint('DeepSeek（深度求索）', true)).toContain('可读取的内容图片');
  });
});


it('shares model/search/content receivers and only own-channel authentication in all disclosure surfaces', () => {
  const settings = panel().settings;
  settings.search.providerName = 'Firecrawl'; settings.search.sourceCapabilities.providerContent = true;
  const lines = outboundReceiverLines(settings).join(' ');
  expect(lines).toContain('搜索词和筛选条件'); expect(lines).toContain('内容接口（Firecrawl）');
  expect(lines).toContain('来源 URL'); expect(lines).toContain('自己的认证通道');
  expect(outboundConfirmedHint('DeepSeek', true, settings)).toContain(lines);
  settings.search.sourceCapabilities.providerContent = false;
  expect(outboundReceiverLines(settings).join(' ')).toContain('直接读取来源网站暂不可用');
});
