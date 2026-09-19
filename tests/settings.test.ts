import { describe, expect, it } from 'vitest';

import { MODEL_PROVIDERS, findProvider } from '../src/core/model-providers';
import { DEFAULT_SETTINGS, effectiveSettings, normalizeSettings } from '../src/core/settings';

describe('设置归一化（产品化改造 F2）', () => {
  it('数值类设置被夹进硬上限范围', () => {
    const clean = normalizeSettings({ learningBudget: 99, maxBubbles: -2 });
    expect(clean.learningBudget).toBe(10);
    expect(clean.maxBubbles).toBe(0);
  });

  it('非法模型 ID 与控制字符提示词被丢弃', () => {
    const clean = normalizeSettings({
      model: '不是模型; drop table',
      prompts: { guide: '正常覆盖', answer: '带\u0000控制字符', learn: '   ' },
    });
    expect(clean.model).toBeUndefined();
    expect(clean.prompts?.guide).toBe('正常覆盖');
    expect(clean.prompts?.answer).toBeUndefined();
    expect(clean.prompts?.learn).toBeUndefined();
  });

  it('空字符串覆盖表示恢复默认，不会写入', () => {
    const clean = normalizeSettings({ prompts: { guide: '' } });
    expect(clean.prompts).toEqual({});
  });

  it('摘要长度只接受已知档位', () => {
    expect(normalizeSettings({ summaryLength: 'long' }).summaryLength).toBe('long');
    // @ts-expect-error 故意传非法值，运行时必须丢弃
    expect(normalizeSettings({ summaryLength: 'huge' }).summaryLength).toBeUndefined();
  });

  it('生效设置：缺省时用默认值，覆盖时用配置值', () => {
    expect(effectiveSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(
      effectiveSettings({ learningBudget: 3, maxBubbles: 1, models: { deepseek: ' custom-model.1 ' } }).learningBudget,
    ).toBe(3);
    expect(effectiveSettings({ maxBubbles: 1 }).maxBubbles).toBe(1);
    expect(effectiveSettings({ models: { deepseek: ' custom-model.1 ' } }).model).toBe('custom-model.1');
    expect(effectiveSettings({ appearance: { fontSize: 'large' } }).fontSize).toBe('large');
  });

  it('模型按供应商分开：切换供应商不会把上一家的模型带过去', () => {
    const config = { provider: 'zhipu', models: { deepseek: 'deepseek-v4-pro' } };
    // 智谱没选过模型 → 用它自己的默认，而不是 DeepSeek 那个。
    expect(effectiveSettings(config).model).toBe(findProvider('zhipu').defaultModel);
    expect(effectiveSettings({ ...config, models: { ...config.models, zhipu: 'glm-4.5-air' } }).model).toBe(
      'glm-4.5-air',
    );
    // 换回 DeepSeek，之前给它选的那个还在。
    expect(effectiveSettings({ ...config, provider: 'deepseek' }).model).toBe('deepseek-v4-pro');
  });

  it('供应商白名单：不认识的值被丢弃，回退到默认那家', () => {
    // @ts-expect-error 故意传非法值，运行时必须丢弃
    expect(normalizeSettings({ provider: 'openai' }).provider).toBeUndefined();
    expect(normalizeSettings({ provider: 'zhipu' }).provider).toBe('zhipu');
    expect(findProvider('openai').id).toBe('deepseek');
    expect(findProvider(undefined).id).toBe('deepseek');
  });

  it('每家的接收方名称各不相同——外发告知要能说清发给谁', () => {
    const receivers = MODEL_PROVIDERS.map((provider) => provider.receiver);
    expect(new Set(receivers).size).toBe(MODEL_PROVIDERS.length);
  });

  it('生效设置：越界存储值也被夹回安全范围', () => {
    const effective = effectiveSettings({ learningBudget: 500, maxBubbles: 99 });
    expect(effective.learningBudget).toBe(10);
    expect(effective.maxBubbles).toBe(3);
  });
});
