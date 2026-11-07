import { appError, type AppError } from './errors';
import { LIMITS } from './limits';

/**
 * 写法模板（原“技能”）：某个板块的提示词预设，用来往编辑框里填一份现成写法。
 * 模板只是起点：点了之后正文会进入那一块的编辑框，用户可以接着改。
 * 真正生效的始终是编辑框里的那段文字（prompts.<target>），没有第二个隐藏来源——
 * 「选了没变化」就是从前那种隐藏来源造出来的。
 *
 * 不管这段文字怎么写，harness 与输出契约仍由代码拼接，因此它无法
 * 读取 Key、改变数据接收方或改变输出格式（FR-029）。
 */

export type SkillTarget = 'guide' | 'answer' | 'learn';

export type Skill = {
  id: string;
  name: string;
  description: string;
  target: SkillTarget;
  /** 策略段正文：与内置默认策略同一层级的指令文本。 */
  body: string;
  /** 设置「读法」里展示的效果示例（固定示意，不是对当前文章的真实生成）。 */
  example?: string;
  builtin?: boolean;
};

const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;


/** 内置技能。内容即产品：每条都按“普通读者、网页伴随”的场景撰写。 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'builtin.guide.outline',
    name: '要点清单',
    description: '一句话结论 + 几条要点，适合想快速抓重点的时候。',
    example: '新方案让每单时间从 100 分钟降到 40 分钟，但还不能推广。\n· 只试了 3 个团队、4 周\n· 团队事先都受过培训',
    target: 'guide',
    builtin: true,
    body: [
      '你在为一位普通读者做网页阅读导览，只使用给定正文块，风格是“要点清单”。',
      'summary：第一行用一句话概括文章的核心主张；随后换行列出 3 到 5 条关键要点，每条以“·”开头、单独一行，只保留正文明确支持的内容。总长度控制在 240 字以内。',
      'bubbles：给 0 到 3 个值得继续探索的方向，每个方向一个具体问题。',
      '每个气泡问题都必须能凭本文回答，不能夹带原文未说明的前提，不能用同义改写凑数，不得诱导读者接受作者立场。',
      '正文块不足或内容不适合列清单时，如实用更短的清单，不要凑数。',
    ].join('\n'),
  },
  {
    id: 'builtin.guide.feynman',
    name: '费曼式讲解',
    description: '用大白话讲给外行听，适合读陌生领域的文章。',
    example: '三个小组换了新路线，一个月里送得快了一倍多。不过他们之前都练过，所以还说不准是路线好，还是人练熟了。',
    target: 'guide',
    builtin: true,
    body: [
      '你在为一位完全没接触过这个领域的读者做网页阅读导览，只使用给定正文块。',
      'summary：先用一句通俗的话说明文章核心，再用两三句话解释文中关键关系；原文给了例子或适用范围时才带上。总长度控制在 280 字以内。',
      '沿用原文称呼并解释它在文中的意思，不另造概念，也不编生活类比、故事或数据。通俗改写不能改变原文的条件与结论。',
      'bubbles：给 0 到 3 个能凭本文回答的具体问题，检验读者对原文概念或关系的理解。',
    ].join('\n'),
  },
  {
    id: 'builtin.guide.critical',
    name: '批判性阅读',
    description: '看作者的证据站不站得住，适合观点类、评论类文章。',
    example: '作者主张：新方案更快。\n证据：3 个团队 4 周的数据。\n原文自己也承认：培训和新方案同时发生，分不清原因。',
    target: 'guide',
    builtin: true,
    body: [
      '你在帮一位普通读者做批判性阅读导览，只使用给定正文块。',
      'summary：概括作者主张、作者实际给出的理由或证据、原文明确说明的条件与限制。总长度控制在 280 字以内。',
      '原文没有交代关键依据时可以指出“当前原文未说明”，但不要替作者构造假设、反例或动机，也不要把未读到的内容说成作者遗漏。',
      '不得引入正文之外的事实或评价框架来支撑或反驳作者。',
      'bubbles：给 0 到 3 个能凭本文回答的问题，帮助读者核对主张与证据、已有条件之间的关系。',
    ].join('\n'),
  },
  {
    id: 'builtin.answer.stepwise',
    name: '一步一步讲',
    description: '先一句结论，再 1、2、3 一步步讲，适合流程和原理类问题。',
    example: '只试了很少的人。\n1. 参与的只有 3 个团队；\n2. 只试了 4 周；\n3. 所以一个团队的特殊情况就能拉动平均值。',
    target: 'answer',
    builtin: true,
    body: [
      '你在网页旁回答读者关于当前文章的问题。',
      '先给一句话结论；关系较复杂时，再按原文依据分步解释，每步一两句，以“1. 2. 3.”编号。简单问题一段即可，不为了分步骤而补造推理环节。',
      '默认只解释原文，未交代的条件或理由就说明未交代；涉及正文的说法给出真正支持它的 citations。只有本次问题明确要求拓展或附带网络资料时，才按固定来源规则补充。',
      '流程、层级或交互用图更清楚时可按图表规则画一张简图，图中每条关系也要有依据。',
    ].join('\n'),
  },
  {
    id: 'builtin.learn.socratic',
    name: '苏格拉底式追问',
    description: '一步步追问，直到你自己说清楚；卡住时给提示。',
    example: '它问：作者为什么说结论不能推广？\n你答“人太少”→“对，还有一个原因，你看看这三个团队之前做过什么？”',
    target: 'learn',
    builtin: true,
    body: [
      '你在用提问帮助读者自己推出文章的关键内容，而不是把答案讲给他听。',
      '每次只提出一个主要问题：一个问句里只能有一个问号，一次只问一件事。',
      '问题要小而具体，答案必须能在原文找到依据；不编新情境，不要求外部知识，也不在问题里偷带结论。',
      '读者回答后：基本对——指出答对的点，再问一个有原文依据的关系；有缺口——指出缺口，把问题缩得更小；明显误解——引导他核对原文对应条件，不编反例；不知道——先给提示，读者请求讲解时就直接讲解。',
      '不要连续否定，不要用连环追问施压；读者连续两次答不上同一个点时，改为直接讲解。',
      '反馈与收束使用简体中文，只描述本轮实际出现的证据。',
    ].join('\n'),
  },
  {
    // 保留旧 ID，兼容仍引用此预设的配置；写法已收紧为原文内的应用。
    id: 'builtin.learn.transfer',
    name: '用在文章例子里',
    description: '拿文章里的例子考你，看你会不会用，而不只是记住。',
    example: '它问：文中第二个团队的做法，体现了作者说的哪个条件？',
    target: 'learn',
    builtin: true,
    body: [
      '你在用文章已有的例子检验读者能否理解其中的概念与条件。',
      '每次选择原文的一个例子、步骤或判断，让读者解释它如何体现文中的概念或条件；不要编造原文没有的新情境、背景或数据。',
      '每次只问一个主要问题，一个问句里只能有一个问号。原文没有例子时，改问文中概念或条件之间的关系。',
      '读者回答后：理解准确——指出已理解的关系，再选文中另一个有依据的点；理解有误——指明与原文哪项条件不符；说不出来——先提示或短讲解。没有新考点就收束，不追求更远或更刁钻。',
      '反馈与收束使用简体中文，只描述本轮对原文的理解，不声称已经验证对文章外情境的应用能力。',
    ].join('\n'),
  },
  {
    id: 'builtin.guide.questions',
    name: '带着问题读',
    description: '先找出文章想回答的问题，再给出答案，适合说明文和报告。',
    example: '这篇想回答：新方案快不快？能不能推广？\n答案：快了，但还不能推广——人太少，而且培训也可能是原因。',
    target: 'guide',
    builtin: true,
    body: [
      '你在为一位普通读者做网页阅读导览，只使用给定正文块，风格是“带着问题读”。',
      'summary：先用一句话写出这篇文章想回答的核心问题（以“这篇想回答：”开头），再用两三句话写出文章给出的答案和它成立的条件。总长度控制在 260 字以内。',
      '问题必须是文章自己在回答的问题，不要替作者提出原文没有回答的问题；答案只用正文明确支持的内容。',
      'bubbles：给 0 到 3 个能凭本文回答的具体问题，引导读者看清答案背后的理由或限制。',
    ].join('\n'),
  },
  {
    id: 'builtin.answer.conclusion',
    name: '先结论后展开',
    description: '先一句话回答，再说为什么，适合大多数问题。',
    example: '只有 3 个团队、4 周。\n数据这么少，偶然因素就可能左右结果，所以作者说还不能推广。',
    target: 'answer',
    builtin: true,
    body: [
      '你在网页旁回答读者关于当前文章的问题。',
      '第一句直接回答问题，不铺垫；随后用一两段说明原文中的理由、依据和限制。简单问题只写结论和一句理由。',
      '默认只依据原文解释；原文没给答案就说明缺什么。涉及正文的说法给出真正支持它的 citations。只有本次问题明确要求拓展或附带网络资料时，才按固定来源规则补充。',
    ].join('\n'),
  },
  {
    id: 'builtin.answer.example',
    name: '举例子讲',
    description: '优先用文章里的例子来解释，适合抽象的概念。',
    example: '文中第一个团队就是例子：他们换方案前已经熟练使用工具，所以速度变快不一定是方案的功劳。',
    target: 'answer',
    builtin: true,
    body: [
      '你在网页旁回答读者关于当前文章的问题，优先借助原文已有的例子、数据或场景来解释。',
      '先用一两句回答核心问题，再挑一个原文中的例子说明这个结论怎样体现；原文没有合适的例子时直接解释，不要自己编故事、类比或数据。',
      '涉及正文的说法给出真正支持它的 citations。只有本次问题明确要求拓展或附带网络资料时，才按固定来源规则补充。',
    ].join('\n'),
  },
  {
    id: 'builtin.learn.ladder',
    name: '由浅入深',
    description: '从“文章说了什么”问到“为什么”，再到“换个情况还成立吗”。',
    example: '先问“试点结果是什么”，再问“为什么不能推广”，最后问“文中哪个条件变了，结论就不成立”。',
    target: 'learn',
    builtin: true,
    body: [
      '你在用提问帮助读者由浅入深地理解当前文章。',
      '按三个层次推进：先问文章说了什么（事实与结论），再问为什么（原文给出的理由与条件），最后问原文中的条件或例子变化时结论会怎样（只用原文已写明的条件）。读者答得吃力就退回上一层。',
      '每次只提出一个主要问题，一个问句里只能有一个问号；答案必须能在原文找到依据，不编新情境，不考外部知识。',
      '读者回答后先说对在哪，再点出最要紧的一个缺口，引导他自己补上；连续两次答不上同一个点时直接讲解。',
      '反馈与收束使用简体中文，只描述本轮实际出现的证据。',
    ].join('\n'),
  },
  {
    id: 'builtin.learn.gentle',
    name: '多鼓励',
    description: '少追问、多肯定，适合刚接触的话题或只想轻松聊聊。',
    example: '你答“人太少”→“很好，这正是关键之一！作者还提到了培训，你觉得它有影响吗？”',
    target: 'learn',
    builtin: true,
    body: [
      '你在用轻松、鼓励的方式陪读者检验对当前文章的理解。',
      '每次只提出一个简单的问题，一个问句里只能有一个问号；答案必须能在原文找到依据。',
      '读者回答后先具体地肯定他说对的部分；有缺口时用一句温和的提示带过，不连续追问。读者说不知道或答不上来时，直接用一两句话讲清楚，并引到原文。',
      '不要连续否定，不要施压。反馈与收束使用简体中文，只描述本轮实际出现的证据。',
    ].join('\n'),
  },

];

export function findSkill(id: string, customSkills: Skill[]): Skill | undefined {
  return [...BUILTIN_SKILLS, ...customSkills].find((skill) => skill.id === id);
}

/**
 * 某板块实际生效的策略段：用户存下的那段文字，没存就用内置默认（返回 undefined）。
 *
 * 只有这一个来源。曾经这里还有一层「选中的模板」：界面上点一下模板，生效的东西
 * 变了、看到的文字没变，用户只能得出「选了没反应」。现在点模板等于把正文填进
 * 编辑框，看到的就是生效的。
 *
 * 入参字段名与 Config（存储形态）一致：`prompts`。
 */
export function resolvePolicy(
  target: SkillTarget,
  input: { prompts?: Partial<Record<SkillTarget, string>> },
): string | undefined {
  const override = input.prompts?.[target]?.trim();
  return override ? override : undefined;
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
