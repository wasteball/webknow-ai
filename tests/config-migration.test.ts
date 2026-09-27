import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 升级迁移：旧版每个板块有一个「选中的模板」（skillChoices），它是一个看不见的
 * 生效来源——界面上点了模板，生效的换了、屏幕上没变。新版只留一个来源：编辑框
 * 里的文字。迁移必须把当时选中的模板正文落成用户自己的文字，否则老用户升级后
 * 生效内容会悄悄变回默认。
 */

const store = new Map<string, unknown>();

vi.mock('wxt/utils/storage', () => ({
  storage: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => void store.set(key, value)),
    removeItem: vi.fn(async (key: string) => void store.delete(key)),
  },
}));

import { readConfig } from '../src/background/store';
import { BUILTIN_SKILLS } from '../src/core/skills';

const KEY = 'local:config';

describe('配置迁移：选中的模板 → 看得见的文字', () => {
  beforeEach(() => store.clear());

  it('把选中的内置模板正文落成用户自己的写法', async () => {
    const template = BUILTIN_SKILLS.find((skill) => skill.target === 'learn')!;
    store.set(KEY, { skillChoices: { learn: template.id } });

    const config = await readConfig();
    expect(config.prompts?.learn).toBe(template.body);
    expect('skillChoices' in config).toBe(false);
    // 落盘一次，之后再读不用再迁。
    expect((store.get(KEY) as { prompts?: { learn?: string } }).prompts?.learn).toBe(template.body);
  });

  it('已经写过自己的文字时不覆盖它', async () => {
    const template = BUILTIN_SKILLS.find((skill) => skill.target === 'learn')!;
    store.set(KEY, { skillChoices: { learn: template.id }, prompts: { learn: '我自己写的' } });

    expect((await readConfig()).prompts?.learn).toBe('我自己写的');
  });

  it('选中的模板已经被删掉时，就回到出厂默认（不写入任何文字）', async () => {
    store.set(KEY, { skillChoices: { learn: 'custom.gone' } });

    const config = await readConfig();
    expect(config.prompts).toBeUndefined();
    expect('skillChoices' in config).toBe(false);
  });
});
