import { appError, type AppError } from './errors';
import { LIMITS } from './limits';

/**
 * 技能（产品化改造 F6）：针对某个板块的提示词预设。
 * 技能 body 只替换该板块的策略段；harness 与输出契约仍由代码拼接，因此技能
 * 无法解除预算、读取 Key、改变数据接收方或输出格式（FR-029）。
 *
 * 生效优先级：用户自定义文本（prompts.<target>）> 所选技能 body > 内置默认策略。
 * 内置技能随代码发布；自定义技能存 storage.local，只在设置页管理。
 */

export type SkillTarget = 'guide' | 'answer' | 'learn';

export type Skill = {
  id: string;
  name: string;
  description: string;
  target: SkillTarget;
  /** 策略段正文：与内置默认策略同一层级的指令文本。 */
  body: string;
  builtin?: boolean;
};

export type SkillChoice = Partial<Record<SkillTarget, string>>;

const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 内置技能。内容即产品：每条都按“普通读者、网页伴随”的场景撰写。 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'builtin.guide.outline',
    name: '要点清单',
    description: '导读摘要改成一句话主张 + 逐条要点，适合快速抓重点。',
    target: 'guide',
    builtin: true,
    body: [
      '你在为一位普通读者做网页阅读导览，只使用给定正文块，风格是“要点清单”。',
      'summary：第一行用一句话概括文章的核心主张；随后换行列出 3 到 5 条关键要点，每条以“·”开头、单独一行，只保留正文明确支持的内容。总长度控制在 240 字以内。',
      'bubbles：给 0 到 3 个值得继续探索的方向，每个方向一个具体问题。',
      '每个气泡问题必须指向本文具体内容，不能用同义改写凑数，不得诱导读者接受作者立场。',
      '正文块不足或内容不适合列清单时，如实用更短的清单，不要凑数。',
    ].join('\n'),
  },
  {
    id: 'builtin.guide.feynman',
    name: '费曼式讲解',
    description: '像讲给完全外行的朋友一样，用日常语言和类比解释这篇文章。',
    target: 'guide',
    builtin: true,
    body: [
      '你在为一位完全没接触过这个领域的读者做网页阅读导览，只使用给定正文块。',
      'summary：先用一个日常生活里的类比把文章核心讲明白（明确标注这是类比），再用两三句话把类比对应回文章本身的说法，最后点出这个结论适用的范围。总长度控制在 280 字以内。',
      '类比不得引入正文之外的事实性主张；只能借用常识场景，不能虚构数据。',
      'bubbles：给 0 到 3 个方向，优先提出能帮读者检验自己是否真的听懂了的问题。',
    ].join('\n'),
  },
  {
    id: 'builtin.guide.critical',
    name: '批判性阅读',
    description: '概括主张与理由，并指出论证中的假设、反例和适用边界。',
    target: 'guide',
    builtin: true,
    body: [
      '你在帮一位普通读者做批判性阅读导览，只使用给定正文块。',
      'summary：分三部分写——作者的主张是什么；作者给了什么理由或证据；论证里有哪些未被证明的假设、可能的反例或适用边界。总长度控制在 280 字以内。',
      '必须区分“作者说的”和“你的分析”：主张与理由来自正文，假设与边界是你的分析，不得把二者混在一起。',
      '不得引入正文之外的事实来支撑或反驳作者。',
      'bubbles：给 0 到 3 个方向，优先提出能检验作者前提或寻找反例的问题。',
    ].join('\n'),
  },
  {
    id: 'builtin.answer.stepwise',
    name: '逐步解释',
    description: '回答先给结论，再分步骤展开，最后说明依据边界。',
    target: 'answer',
    builtin: true,
    body: [
      '你在网页旁回答读者关于当前文章的问题。',
      '回答结构固定为三段：先给一句话结论；再分步骤展开理由或推理，每步一两句、以“1. 2. 3.”编号；最后用一句话说明这条回答的依据边界——哪些来自正文、哪些是你的补充。',
      '来源标注与引用规则照旧：主要依据来自正文块时必须给 citations；补充内容如实标注。',
    ].join('\n'),
  },
  {
    id: 'builtin.learn.socratic',
    name: '苏格拉底式追问',
    description: '不直接给答案，用一连串具体小问题引导读者自己推出结论。',
    target: 'learn',
    builtin: true,
    body: [
      '你在用提问帮助读者自己推出文章的关键内容，而不是把答案讲给他听。',
      '每次只提出一个主要问题：一个问句里只能有一个问号，一次只问一件事。',
      '问题要小而具体，指向文章的具体内容，让读者能凭正文加上自己的思考回答出来。',
      '读者回答后：基本对——肯定他，并把下一问推进一层；有缺口——指出缺口，把问题缩得更小；明显误解——不要直接纠正，用一个反例或边界情境让矛盾暴露出来；不知道——先给提示，再等他试一次。',
      '不要连续否定，不要用连环追问施压；读者连续两次答不上同一个点时，改为直接讲解。',
      '反馈与收束使用简体中文，只描述本轮实际出现的证据。',
    ].join('\n'),
  },
  {
    id: 'builtin.learn.transfer',
    name: '应用迁移',
    description: '出题聚焦“换一个情境还会不会用”，检验读者是否真正掌握。',
    target: 'learn',
    builtin: true,
    body: [
      '你在用提问帮助读者检验自己能否把文章内容用到新情境里。',
      '每个问题都给一个文章里没有直接出现过的贴近生活的新情境，问读者在这个情境里该怎么判断或怎么做，并要求他说出依据对应文章里的哪一点。',
      '每次只问一个情境：一个问句里只能有一个问号。',
      '读者回答后：能正确迁移——肯定他，并换一个更远或更刁钻的情境；迁移错误——指出他的判断用错了哪条正文依据；说不出来——先给提示（情境不变，缩小问题）。',
      '反馈与收束使用简体中文；收束时说明读者在哪些类型的情境上迁移成功、哪些还不稳。',
    ].join('\n'),
  },
];

export function findSkill(id: string, customSkills: Skill[]): Skill | undefined {
  return [...BUILTIN_SKILLS, ...customSkills].find((skill) => skill.id === id);
}

/**
 * 解析某板块实际生效的策略段：自定义文本 > 所选技能 > 内置默认（返回 undefined）。
 * 选中的技能已不存在（被删除）时静默回退，不让一次设置损坏整个板块。
 */
export function resolvePolicy(
  target: SkillTarget,
  input: { overrides?: Partial<Record<SkillTarget, string>>; skillChoices?: SkillChoice; customSkills?: Skill[] },
): string | undefined {
  const override = input.overrides?.[target]?.trim();
  if (override) return override;
  const chosenId = input.skillChoices?.[target];
  if (!chosenId) return undefined;
  return findSkill(chosenId, input.customSkills ?? [])?.body;
}

/** 自定义技能的新增/修改校验：不合格直接拒绝，不静默修正。 */
export function validateCustomSkill(input: {
  id?: string;
  name: string;
  description: string;
  target: SkillTarget;
  body: string;
}): { ok: true; value: Skill } | { ok: false; error: AppError } {
  const name = input.name.trim();
  const description = input.description.trim();
  const body = input.body.trim();
  if (!name || name.length > 40) {
    return { ok: false, error: appErrorOf('技能名称不能为空，也不能超过 40 字。') };
  }
  if (description.length > 200) {
    return { ok: false, error: appErrorOf('技能说明不能超过 200 字。') };
  }
  if (!body || body.length > LIMITS.maxTeachingPromptChars) {
    return {
      ok: false,
      error: appErrorOf(`技能内容不能为空，也不能超过 ${LIMITS.maxTeachingPromptChars} 字。`),
    };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(name + description + body)) {
    return { ok: false, error: appErrorOf('技能内容里有看不见的特殊字符，没法保存。') };
  }
  const id = input.id?.trim();
  if (id !== undefined && !SKILL_ID_PATTERN.test(id)) {
    return { ok: false, error: appErrorOf('这个技能的标识不合法。') };
  }
  return {
    ok: true,
    value: {
      id: id || `custom.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      description,
      target: input.target,
      body,
    },
  };
}

function appErrorOf(message: string): AppError {
  return appError('BAD_OUTPUT', message, false);
}
