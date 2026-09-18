import { describe, expect, it } from 'vitest';

import { BUILTIN_SKILLS, findSkill, resolvePolicy, validateCustomSkill } from '../src/core/skills';

describe('技能（产品化改造 F6）', () => {
  it('内置技能覆盖三个板块且内容完整', () => {
    const targets = new Set(BUILTIN_SKILLS.map((skill) => skill.target));
    expect(targets.has('guide')).toBe(true);
    expect(targets.has('answer')).toBe(true);
    expect(targets.has('learn')).toBe(true);
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.body.length).toBeGreaterThan(50);
      expect(skill.body).not.toContain('JSON');
    }
  });

  it('策略解析优先级：自定义文本 > 技能 > 默认', () => {
    const custom = BUILTIN_SKILLS[0]!;
    expect(resolvePolicy('guide', {})).toBeUndefined();
    expect(resolvePolicy('guide', { skillChoices: { guide: custom.id } })).toBe(custom.body);
    expect(
      resolvePolicy('guide', {
        overrides: { guide: '我自己写的' },
        skillChoices: { guide: custom.id },
      }),
    ).toBe('我自己写的');
  });

  it('选中的技能被删除后静默回退默认', () => {
    expect(resolvePolicy('guide', { skillChoices: { guide: 'custom.gone' } })).toBeUndefined();
  });

  it('findSkill 能在内置与自定义里查找', () => {
    expect(findSkill(BUILTIN_SKILLS[0]!.id, [])).toBe(BUILTIN_SKILLS[0]);
    expect(findSkill('missing', [])).toBeUndefined();
  });

  it('自定义技能校验：非法输入被拒绝', () => {
    expect(validateCustomSkill({ name: '', description: '', target: 'learn', body: 'x' }).ok).toBe(false);
    expect(
      validateCustomSkill({ name: '名字', description: '', target: 'learn', body: '' }).ok,
    ).toBe(false);
    expect(
      validateCustomSkill({ name: '名'.repeat(41), description: '', target: 'learn', body: '正文' }).ok,
    ).toBe(false);
  });

  it('自定义技能校验：合法输入得到规范化的技能', () => {
    const clean = validateCustomSkill({
      name: '  我的技能  ',
      description: '说明',
      target: 'answer',
      body: '  认真干活。  ',
    });
    expect(clean.ok).toBe(true);
    if (clean.ok) {
      expect(clean.value.name).toBe('我的技能');
      expect(clean.value.body).toBe('认真干活。');
      expect(clean.value.id).toMatch(/^custom\./);
      expect(clean.value.builtin).toBeUndefined();
    }
  });

  it('显式 id 必须合法', () => {
    expect(
      validateCustomSkill({ id: 'bad id!', name: 'n', description: '', target: 'learn', body: 'b' }).ok,
    ).toBe(false);
    expect(
      validateCustomSkill({ id: 'custom.ok1', name: 'n', description: '', target: 'learn', body: 'b' }).ok,
    ).toBe(true);
  });
});
