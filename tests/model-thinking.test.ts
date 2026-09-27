import { describe, expect, it } from 'vitest';

import { LIMITS } from '../src/core/limits';
import { rememberThinking, resolveThinking, thinkingChoices, thinkingRequest } from '../src/core/model-thinking';

describe('思考档位', () => {
  it('DeepSeek 两个已知模型默认关，可选关、低、高、极致', () => {
    for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
      expect(thinkingChoices(model)?.map((choice) => choice.label)).toEqual(['关', '低', '高', '极致']);
      expect(resolveThinking(model, undefined)).toBe('off');
    }
  });

  it('glm-5.2 默认是「默认」，不提供「低」', () => {
    expect(thinkingChoices('glm-5.2')?.map((choice) => choice.value)).toEqual(['auto', 'off', 'high', 'max']);
    expect(resolveThinking('glm-5.2', undefined)).toBe('auto');
    expect(resolveThinking('glm-5.2', 'low')).toBe('auto');
  });

  it('智谱 4 系列和手填的名字没有档位', () => {
    for (const model of ['glm-4.6', 'glm-4.7', 'glm-4.5-air', 'glm-4.5-flash', 'my-custom-model']) {
      expect(thinkingChoices(model)).toBeNull();
      expect(resolveThinking(model, 'high')).toBeNull();
    }
  });

  it('记住的档只在这个模型自己的列表里才算数', () => {
    expect(resolveThinking('deepseek-v4-pro', 'max')).toBe('max');
    expect(resolveThinking('deepseek-flash', 'auto')).toBe('off');
  });
});

describe('思考请求体', () => {
  it('DeepSeek 关着时关闭思考，不带强度，输出上限仍是 1200', () => {
    expect(thinkingRequest({ providerId: 'deepseek', modelId: 'deepseek-flash' })).toEqual({
      thinking: { type: 'disabled' },
      maxTokens: LIMITS.maxOutputTokens,
    });
  });

  it('DeepSeek 打开高这一档时带上强度，并把输出上限提高到仍有限的值', () => {
    const body = thinkingRequest({ providerId: 'deepseek', modelId: 'deepseek-v4-pro', stored: 'high' });
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoningEffort).toBe('high');
    expect(body.maxTokens).toBeGreaterThan(LIMITS.maxOutputTokens);
    expect(body.maxTokens).toBeLessThan(64_000);
  });

  it('DeepSeek 的低和极致对应 low 与 max', () => {
    expect(thinkingRequest({ providerId: 'deepseek', modelId: 'deepseek-flash', stored: 'low' }).reasoningEffort).toBe(
      'low',
    );
    expect(thinkingRequest({ providerId: 'deepseek', modelId: 'deepseek-flash', stored: 'max' }).reasoningEffort).toBe(
      'max',
    );
  });

  it('手填的 DeepSeek 模型名维持关闭，即使存过极致', () => {
    const body = thinkingRequest({ providerId: 'deepseek', modelId: 'deepseek-reasoner', stored: 'max' });
    expect(body).toEqual({ thinking: { type: 'disabled' }, maxTokens: LIMITS.maxOutputTokens });
  });

  it('glm-5.2 默认不写思考字段，输出上限不变', () => {
    expect(thinkingRequest({ providerId: 'zhipu', modelId: 'glm-5.2' })).toEqual({
      maxTokens: LIMITS.maxOutputTokens,
    });
  });

  it('glm-5.2 的关是明确关闭，高和极致才带强度', () => {
    expect(thinkingRequest({ providerId: 'zhipu', modelId: 'glm-5.2', stored: 'off' })).toEqual({
      thinking: { type: 'disabled' },
      maxTokens: LIMITS.maxOutputTokens,
    });
    expect(thinkingRequest({ providerId: 'zhipu', modelId: 'glm-5.2', stored: 'high' })).toMatchObject({
      thinking: { type: 'enabled' },
      reasoningEffort: 'high',
    });
    expect(thinkingRequest({ providerId: 'zhipu', modelId: 'glm-5.2', stored: 'max' }).reasoningEffort).toBe('max');
  });

  it('glm-4.6 不写思考字段，存过的档也不打开', () => {
    expect(thinkingRequest({ providerId: 'zhipu', modelId: 'glm-4.6', stored: 'max' })).toEqual({
      maxTokens: LIMITS.maxOutputTokens,
    });
  });

  it('调用方给了输出上限时不抬高，连接测试维持很小的上限', () => {
    expect(
      thinkingRequest({ providerId: 'deepseek', modelId: 'deepseek-flash', stored: 'max', maxTokens: 16 }).maxTokens,
    ).toBe(16);
  });
});

describe('记下思考档', () => {
  it('记在当前这家的当前模型上，不覆盖别的模型', () => {
    const next = rememberThinking(
      { provider: 'deepseek', models: { deepseek: 'deepseek-v4-pro' }, thinking: { deepseek: { 'deepseek-flash': 'low' } } },
      { thinking: 'max' },
    );
    expect(next).toEqual({ deepseek: { 'deepseek-flash': 'low', 'deepseek-v4-pro': 'max' } });
  });

  it('这个模型没有档位，或档位不在它的列表里，就不写', () => {
    const current = { provider: 'zhipu' as const, models: { zhipu: 'glm-4.6' }, thinking: { deepseek: { 'deepseek-flash': 'low' as const } } };
    expect(rememberThinking(current, { thinking: 'max' })).toEqual(current.thinking);
    expect(rememberThinking({ provider: 'zhipu', models: { zhipu: 'glm-5.2' } }, { thinking: 'low' })).toBeUndefined();
  });

  it('这次没改思考，原来记下的还在', () => {
    const current = { thinking: { deepseek: { 'deepseek-flash': 'high' as const } } };
    expect(rememberThinking(current, { model: 'deepseek-v4-pro' })).toEqual(current.thinking);
  });
});
