import { useEffect, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';

import { ANSWER_DEFAULT_POLICY } from '../../core/prompts/answer';
import { GUIDE_DEFAULT_POLICY, summaryCharsFor } from '../../core/prompts/guide';
import { LEARN_DEFAULT_POLICY } from '../../core/prompts/learn';
import type { Command, PanelState, Reply } from '../../core/protocol';
import type { PromptTarget } from '../../core/settings';
import { BUILTIN_SKILLS, type Skill } from '../../core/skills';
import { SearchSettings } from './SearchSettings';
import { Notice, Section } from './bits';
import { BrandMark, Icon, type IconName } from './Icon';
import { ModelSettings as ModelAndKey } from './ModelSettings';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 设置：整页标签页（options.html），左侧分类（按组排列）+ 右侧内容。
 * 侧栏 ⋯ → 设置、扩展选项入口都打开这里；改设置时注意力本就不在阅读上，也不该被侧栏宽度限制。
 * 非敏感设置统一走 saveSettings；Key 仍是独立命令与独立校验。
 * 清除这一页、清除全部、删掉钥匙、恢复默认读法，互不牵连（FR-033）。
 */

export type CategoryId = 'model' | 'readway' | 'general' | 'appearance' | 'search' | 'ima' | 'data' | 'about';

const CATEGORIES: { id: CategoryId; label: string; icon: IconName; group: number }[] = [
  { id: 'model', label: 'AI 服务', icon: 'key', group: 0 },
  { id: 'readway', label: '读法', icon: 'book', group: 0 },
  { id: 'general', label: '阅读偏好', icon: 'sliders', group: 0 },
  { id: 'appearance', label: '外观', icon: 'sun', group: 0 },
  { id: 'search', label: '联网搜索', icon: 'globe', group: 1 },
  { id: 'ima', label: '知识库', icon: 'shelf', group: 1 },
  { id: 'data', label: '隐私与数据', icon: 'lock', group: 2 },
  { id: 'about', label: '关于与帮助', icon: 'help', group: 2 },
];

/** 旧链接（#prompts）仍能落到对应页。 */
function categoryFrom(id: string): CategoryId | null {
  if (id === 'prompts') return 'readway';
  return CATEGORIES.some((item) => item.id === id) ? (id as CategoryId) : null;
}

function PageLead({ title, lead }: { title: string; lead: string }) {
  return (
    <header className="page-head">
      <h2>{title}</h2>
      <p>{lead}</p>
    </header>
  );
}

function SetList({ children }: { children: ReactNode }) {
  return <div className="set-list">{children}</div>;
}

function SetRow({
  title,
  hint,
  stack,
  children,
}: {
  title: string;
  hint?: string;
  stack?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={stack ? 'set-row set-row-stack' : 'set-row'}>
      <div className="set-row-copy">
        <p className="set-row-title">{title}</p>
        {hint ? <p className="set-row-hint">{hint}</p> : null}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function Seg<T extends string>({
  name,
  value,
  options,
  disabled,
  onChange,
}: {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={name}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const PROMPT_TARGETS: { key: PromptTarget; title: string; hint: string; defaultExample: string }[] = [
  {
    key: 'guide',
    title: '怎么总结',
    hint: '打开文章时那段摘要和可以点的问题。',
    defaultExample: '三五句话说清这篇讲了什么、结论是什么，再给几个可以直接点的问题。',
  },
  {
    key: 'answer',
    title: '怎么回答',
    hint: '你在「问 AI」里提问时它的回答方式。',
    defaultExample: '先用一两句回答你问的，再说文章里的依据和限制；文章没说的会直说没写。',
  },
  {
    key: 'learn',
    title: '怎么考你',
    hint: '「AI 问」里它怎么出题、怎么回应你的回答。',
    defaultExample: '一次只问一个问题，先说你对在哪，再点出最要紧的一处，引导你自己补上。',
  },
];

const TARGET_LABEL: Record<PromptTarget, string> = {
  guide: '怎么总结',
  answer: '怎么回答',
  learn: '怎么考你',
};

export function Settings({
  state,
  send,
  notice,
  onDismissNotice,
}: {
  state: PanelState;
  send: Send;
  notice: string | null;
  onDismissNotice: () => void;
}) {
  const [category, setCategory] = useState<CategoryId>(() => categoryFrom(location.hash.replace(/^#/, '')) ?? 'general');
  // 侧栏再次点设置会把已开着的设置页改到新的 #分类，这里跟上。
  useEffect(() => {
    const onHash = () => { const next = categoryFrom(location.hash.replace(/^#/, '')); if (next) setCategory(next); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const content = (id: CategoryId) => <>
    {id === 'general' && <ReadingPrefs state={state} send={send} />}
    {id === 'appearance' && <Appearance state={state} send={send} />}
    {id === 'model' && <ModelAndKey state={state} send={send} />}
    {id === 'readway' && <>
      <Readway state={state} send={send} />
      <Skills state={state} send={send} />
    </>}
    {id === 'search' && <SearchSettings state={state} send={send} />}
    {id === 'ima' && <ImaSettings state={state} send={send} />}
    {id === 'data' && <Cleanup state={state} send={send} />}
    {id === 'about' && <About />}
  </>;

  const active = category;
  return (
    <div className="settings-page">
      {/* 导航在窄屏会变成可横向滚动的长条，所以给键盘用户一条直通正文的捷径。 */}
      <a className="skip-link" href="#settings-content">
        跳到设置内容
      </a>
      <header className="settings-topbar">
        <p className="settings-brand">
          <BrandMark size={24} />
          WebKnow AI
        </p>
        <p className="settings-tagline">设置</p>
      </header>
      <div className="settings-shell">
        <nav className="settings-nav" aria-label="设置分类">
          {CATEGORIES.map((item, index) => (
            <button
              key={item.id}
              data-group-start={index > 0 && CATEGORIES[index - 1]!.group !== item.group ? 'true' : undefined}
              type="button"
              aria-current={active === item.id ? 'true' : undefined}
              onClick={() => setCategory(item.id)}
            >
              <Icon name={item.icon} small />
              {item.label}
            </button>
          ))}
        </nav>
        <main className="settings-content" id="settings-content" tabIndex={-1}>
          {notice && <Notice text={notice} onDismiss={onDismissNotice} />}
          {content(active)}
        </main>
      </div>
    </div>
  );
}

function methodsFor(target: PromptTarget, settings: PanelState['settings']): Skill[] {
  return [...BUILTIN_SKILLS, ...settings.customSkills].filter((skill) => skill.target === target);
}

/** 当前生效的是哪一套：存的正文与某套现成方法一致就算选中它；没存就是默认。 */
function currentMethod(target: PromptTarget, settings: PanelState['settings']): Skill | 'default' | 'custom' {
  const saved = settings.prompts[target]?.trim();
  if (!saved) return 'default';
  return methodsFor(target, settings).find((skill) => skill.body.trim() === saved) ?? 'custom';
}

/**
 * 读法（原“提示词”）：三块各一组现成方法，点一下就换成那一套并立即保存。
 * 仍然只有一个生效来源——存下的那段正文；“自己写 / 在这套基础上改”展开的编辑框里就是它。
 */
function Readway({ state, send }: { state: PanelState; send: Send }) {
  const { settings } = state;
  const [tab, setTab] = useState<PromptTarget>('guide');
  const [busy, setBusy] = useState(false);
  const target = PROMPT_TARGETS.find((item) => item.key === tab)!;

  const defaults: Record<PromptTarget, string> = {
    guide: GUIDE_DEFAULT_POLICY({
      maxBubbles: settings.maxBubbles,
      summaryMaxChars: summaryCharsFor(settings.summaryLength),
    }),
    answer: ANSWER_DEFAULT_POLICY,
    learn: LEARN_DEFAULT_POLICY,
  };
  const methods = methodsFor(tab, settings);
  const current = currentMethod(tab, settings);
  const example = current === 'default' ? target.defaultExample
    : current === 'custom' ? '你自己写的读法，效果以实际生成为准。'
    : current.example ?? current.description;

  const pick = async (body: string) => {
    setBusy(true);
    try { await send({ type: 'saveSettings', patch: { prompts: { [tab]: body } } }); }
    finally { setBusy(false); }
  };

  return (
    <section className="section readway">
      <PageLead title="读法" lead="普通情况用默认就好。想让它换种方式总结、回答或考你，在这里挑一套；下一次生成就用新的方法。" />
      <div className="rtabs" role="tablist" aria-label="读法分类">
        {PROMPT_TARGETS.map((item) => (
          <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} onClick={() => setTab(item.key)}>
            {item.title}
          </button>
        ))}
      </div>
      <p className="hint">{target.hint}</p>
      <div className="preview" aria-live="polite">
        <p className="preview-k"><Icon name="play" small />大致会是这样（示意）</p>
        <p className="preview-body">{example}</p>
      </div>
      <div className="group" role="radiogroup" aria-label={target.title}>
        <MethodOption name="默认" note="推荐" description="我们调好的做法，大多数文章都合适。"
          checked={current === 'default'} disabled={busy} onPick={() => void pick('')} />
        {methods.map((skill) => (
          <MethodOption key={skill.id} name={skill.name} note={skill.builtin ? undefined : '我的'}
            description={skill.description || '（没有说明）'}
            checked={current !== 'default' && current !== 'custom' && current.id === skill.id}
            disabled={busy} onPick={() => void pick(skill.body)} />
        ))}
        {current === 'custom' && <MethodOption name="自己写的" description="下面编辑框里的那段。" checked disabled={busy} onPick={() => {}} />}
      </div>
      <details className="readway-edit">
        <summary>自己写，或在这套基础上改</summary>
        <PromptCard
          key={tab}
          target={target}
          fallback={defaults[tab]}
          saved={settings.prompts[tab] ?? ''}
          send={send}
        />
      </details>
      <p className="hint">无论怎么写，内容发给谁、钥匙、回答要标明依据这些规则都改不了。</p>
    </section>
  );
}

function MethodOption({ name, note, description, checked, disabled, onPick }: {
  name: string; note?: string; description: string; checked: boolean; disabled: boolean; onPick: () => void;
}) {
  return (
    <button type="button" role="radio" className="method" aria-checked={checked} disabled={disabled} onClick={onPick}>
      <span className="radio" aria-hidden="true" />
      <span className="method-copy">
        <span className="method-name">{name}{note && <span className="method-note">{note}</span>}</span>
        <span className="method-desc">{description}</span>
      </span>
    </button>
  );
}

function PromptCard({
  target,
  fallback,
  saved,
  send,
}: {
  target: { key: PromptTarget; title: string };
  /** 没存过自己的写法时，用的是这份内置默认。 */
  fallback: string;
  saved: string;
  send: Send;
}) {
  const inEffect = saved || fallback;
  const [draft, setDraft] = useState(inEffect);
  const [busy, setBusy] = useState(false);
  // 别处（比如点了现成方法、恢复默认）改过之后，跟上新的生效内容；
  // 正在改的草稿不能被覆盖掉，所以只在草稿等于上一份生效内容时才跟。
  const [synced, setSynced] = useState(inEffect);
  if (synced !== inEffect) {
    setSynced(inEffect);
    if (draft === synced) setDraft(inEffect);
  }

  const save = async (text: string) => {
    setBusy(true);
    await send({ type: 'saveSettings', patch: { prompts: { [target.key]: text } } });
    setBusy(false);
  };

  const isDefault = !saved;
  const dirty = draft.trim() !== inEffect.trim();

  return (
    <article className="set-card">
      <div className="set-card-head">
        <h3>
          {target.title}
          <span className="tag">{isDefault ? '出厂默认' : '你改过'}</span>
        </h3>
        <p>框里就是它现在照着做的那段话，改完保存就生效。</p>
      </div>
      <textarea
        id={`prompt-${target.key}`}
        aria-label={`${target.title}：现在照着做的那段话`}
        rows={10}
        maxLength={8000}
        value={draft}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="composer-actions">
        <button type="button" disabled={busy || !draft.trim() || !dirty} onClick={() => void save(draft)}>
          {dirty ? '保存' : '已保存'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || (isDefault && !dirty)}
          onClick={() => {
            setDraft(fallback);
            // 存空串 = 清掉覆盖、回到出厂默认（core/settings 的既有语义）。
            if (saved) void save('');
          }}
        >
          恢复默认
        </button>
      </div>
      {dirty && <p className="hint">改完要点保存才会生效。下一次生成才用新的写法，已经写出来的内容不会重写。</p>}
    </article>
  );
}

/** 我的读法：把常用写法命名存下来，之后在上面的方法列表里一键切换。 */
function Skills({ state, send }: { state: PanelState; send: Send }) {
  const customs = state.settings.customSkills;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState<PromptTarget>('learn');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (command: Command) => {
    setBusy(true);
    const reply = await send(command);
    setBusy(false);
    return reply;
  };

  const submit = async () => {
    const reply = await run({ type: 'saveSkill', skill: { name, target, description, body } });
    if (reply?.ok) {
      setName('');
      setDescription('');
      setBody('');
      setAdding(false);
    }
  };

  return (
    <Section title="我的读法">
      <p className="hint">存下来的读法会出现在上面对应那一块的方法列表里，点一下就换上。</p>
      <ul className="skill-list">
        {customs.length === 0 && !adding && <li className="hint">还没有自己存的读法。</li>}
        {customs.map((skill) => (
          <li key={skill.id}>
            <p className="skill-name">
              {skill.name}
              <span className="tag">{TARGET_LABEL[skill.target]}</span>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void run({ type: 'deleteSkill', id: skill.id })}
              >
                删除
              </button>
            </p>
            <p className="hint">{skill.description || '（没有说明）'}</p>
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="field">
          <label htmlFor="skill-name">起个名字</label>
          <input
            id="skill-name"
            type="text"
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <label htmlFor="skill-target">用在哪个板块</label>
          <select
            id="skill-target"
            value={target}
            onChange={(event) => setTarget(event.target.value as PromptTarget)}
          >
            <option value="guide">怎么总结</option>
            <option value="answer">怎么回答</option>
            <option value="learn">怎么考你</option>
          </select>
          <label htmlFor="skill-description">一句话说明（可选）</label>
          <input
            id="skill-description"
            type="text"
            maxLength={200}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <label htmlFor="skill-body">具体怎么做（写给 AI 的说明）</label>
          <textarea
            id="skill-body"
            rows={8}
            maxLength={8000}
            value={body}
            placeholder="像给一个能干的助手写工作守则一样写。输出格式不用写，程序会保证。"
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="composer-actions">
            <button type="button" disabled={busy || !name.trim() || !body.trim()} onClick={() => void submit()}>
              保存这套读法
            </button>
            <button type="button" className="secondary" onClick={() => setAdding(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="composer-actions">
          <button type="button" className="secondary" onClick={() => setAdding(true)}>
            新建一套读法
          </button>
        </div>
      )}
    </Section>
  );
}


function ImaSettings({ state, send }: { state: PanelState; send: Send }) {
  const current = state.settings.ima;
  const [clientId, setClientId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [items, setItems] = useState<{ id: string; name: string; contentCount: number }[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (command: Command) => {
    setBusy(true);
    const reply = await send(command);
    setBusy(false);
    return reply;
  };

  /** 连接：先在用户手势里申请 ima.qq.com 权限（第一个异步调用，前面不能有 await），再取知识库列表。 */
  const connect = async () => {
    try {
      const granted = await browser.permissions.request({ origins: ['https://ima.qq.com/*'] });
      if (!granted) {
        setHint('没有授予知识库服务访问权限。可以稍后再试。');
        return;
      }
    } catch {
      setHint('浏览器没有弹出授权窗口。请关掉侧栏重新打开后再试。');
      return;
    }
    const reply = await run({ type: 'listImaKb', credentials: { clientId: clientId.trim(), apiKey: apiKey.trim() } });
    if (reply?.ok && reply.data?.imaKbItems) {
      setItems(reply.data.imaKbItems);
      setHint(`连接成功，找到 ${reply.data.imaKbItems.length} 个知识库。选一个作为默认保存位置。`);
    } else {
      setHint(reply && !reply.ok ? reply.error.message : '没能取得知识库列表，请检查凭证。');
    }
  };

  return (
    <Section title="知识库（腾讯 ima）">
      <p className="hint">在 ima 官网用微信扫码登录后，可以查看个人、共享和订阅知识库。</p>
      <a className="ima-open" href="https://ima.qq.com/" target="_blank" rel="noopener noreferrer">
        打开 ima，扫码查看知识库
        <Icon name="external" small />
      </a>
      <p className="hint">扫码只登录 ima 官网；若要让WebKnow AI访问知识库，还需配置开放接口凭证。</p>
      <p className="hint">连好并选定默认知识库后，侧栏摘要下面的「收藏到知识库」一点就能把这一页和阅读笔记（摘要、问答、学习小结）存进去。</p>
      {current.enabled ? (
        <>
          <p className="hint">已连接{current.kbName ? `，默认保存到「${current.kbName}」` : '，还没有选择默认知识库'}。</p>
          {!current.kbName && (
            <div className="composer-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run({ type: 'listImaKb' }).then((reply) => {
                    if (reply?.ok && reply.data?.imaKbItems) setItems(reply.data.imaKbItems);
                  })
                }
              >
                重新获取知识库列表
              </button>
            </div>
          )}
          {items && items.length > 0 && (
            <div className="field">
              <label htmlFor="ima-kb">默认保存到</label>
              <select
                id="ima-kb"
                disabled={busy}
                onChange={(event) => {
                  const option = event.target.selectedOptions[0];
                  if (option) void run({ type: 'saveImaKb', kbId: option.value, kbName: option.text });
                }}
                defaultValue=""
              >
                <option value="" disabled>
                  选择知识库…
                </option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="composer-actions">
            <button type="button" className="danger" disabled={busy} onClick={() => void run({ type: 'deleteImaConfig' })}>
              删除知识库连接
            </button>
          </div>
          <p className="hint">删除连接不影响已存入 ima 的内容。</p>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="ima-client-id">
              应用编号 <span className="set-code">Client ID</span>
            </label>
            <input
              id="ima-client-id"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ima-api-key">
              钥匙 <span className="set-code">API Key</span>
            </label>
            <input
              id="ima-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          <p className="hint">
            这两项在{' '}
            <a href="https://ima.qq.com/agent-interface" target="_blank" rel="noreferrer">
              ima 的开放接口页面
            </a>{' '}
            生成（需要先有 ima 账号）。凭证只存在这个浏览器里。
          </p>
          {hint && <p className="hint">{hint}</p>}
          {items && items.length > 0 && (
            <div className="field">
              <label htmlFor="ima-kb-first">默认保存到</label>
              <select
                id="ima-kb-first"
                disabled={busy}
                onChange={(event) => {
                  const option = event.target.selectedOptions[0];
                  if (option) {
                    void run({
                      type: 'saveImaConfig',
                      clientId: clientId.trim(),
                      apiKey: apiKey.trim(),
                    }).then(() => run({ type: 'saveImaKb', kbId: option.value, kbName: option.text }));
                  }
                }}
                defaultValue=""
              >
                <option value="" disabled>
                  选择知识库…
                </option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="composer-actions">
            <button type="button" disabled={busy || !clientId.trim() || !apiKey.trim()} onClick={() => void connect()}>
              授权并连接
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

function ReadingPrefs({ state, send }: { state: PanelState; send: Send }) {
  const { settings } = state;
  const [busy, setBusy] = useState(false);
  const change = (patch: Parameters<typeof send>[0]) => {
    if (patch.type !== 'saveSettings') return;
    setBusy(true);
    void send(patch).finally(() => setBusy(false));
  };

  return (
    <>
      <PageLead title="阅读偏好" lead="摘要多长、给几个问题、它怎么问你。改完立刻生效。" />
      <SetList>
        <SetRow title="它怎么问你" hint="选择题好勾；开口答能看出你是不是真懂。聊到哪里算完，你说了算。">
          <Seg
            name="「AI 问」怎么出题"
            value={settings.learningStyle}
            options={[
              { value: 'mixed', label: '自动' },
              { value: 'quiz', label: '选择题' },
              { value: 'open', label: '开口答' },
            ]}
            disabled={busy}
            onChange={(value) =>
              change({ type: 'saveSettings', patch: { learningStyle: value as 'mixed' | 'quiz' | 'open' } })
            }
          />
        </SetRow>
        <SetRow title="摘要长短" hint="打开侧栏最先看到的那一段。">
          <Seg
            name="摘要长度"
            value={settings.summaryLength}
            options={[
              { value: 'short', label: '短' },
              { value: 'medium', label: '中' },
              { value: 'long', label: '长' },
            ]}
            disabled={busy}
            onChange={(value) =>
              change({
                type: 'saveSettings',
                patch: { summaryLength: value as 'short' | 'medium' | 'long' },
              })
            }
          />
        </SetRow>
        <SetRow title="可点的问题" hint="摘要下面给几个可以直接点的问题。">
          <Seg
            name="话题卡片数量上限"
            value={String(settings.maxBubbles)}
            options={[
              { value: '0', label: '不要' },
              { value: '2', label: '2' },
              { value: '3', label: '3' },
              { value: '4', label: '4' },
            ]}
            disabled={busy}
            onChange={(value) => change({ type: 'saveSettings', patch: { maxBubbles: Number(value) } })}
          />
        </SetRow>
        <SetRow title="回答里的图表" hint="流程、层级、因果这类结构，画成图比写成句子好懂。">
          <Seg
            name="回答里是否配图表"
            value={settings.diagrams}
            options={[
              { value: 'auto', label: '自动' },
              { value: 'off', label: '不要图' },
            ]}
            disabled={busy}
            onChange={(value) =>
              change({ type: 'saveSettings', patch: { diagrams: value as 'auto' | 'off' } })
            }
          />
        </SetRow>
      </SetList>
    </>
  );
}

function Appearance({ state, send }: { state: PanelState; send: Send }) {
  const { settings } = state;
  const [busy, setBusy] = useState(false);
  const change = (patch: Parameters<typeof send>[0]) => {
    if (patch.type !== 'saveSettings') return;
    setBusy(true);
    void send(patch).finally(() => setBusy(false));
  };
  return (
    <>
      <PageLead title="外观" lead="深色、浅色跟随你的系统设置。" />
      <SetList>
        <SetRow title="文字大小">
          <Seg
            name="文字大小"
            value={settings.fontSize}
            options={[
              { value: 'normal', label: '标准' },
              { value: 'large', label: '大' },
            ]}
            disabled={busy}
            onChange={(value) =>
              change({ type: 'saveSettings', patch: { fontSize: value as 'normal' | 'large' } })
            }
          />
        </SetRow>
      </SetList>
    </>
  );
}

function Cleanup({ state, send }: { state: PanelState; send: Send }) {
  const [busy, setBusy] = useState(false);
  const tabId = state.tabId;
  const run = async (command: Command) => {
    setBusy(true);
    await send(command);
    setBusy(false);
  };
  return (
    <Section title="隐私与数据">
      <p className="hint">摘要和对话只在这次打开浏览器时留着，关掉浏览器就没了。钥匙只存在这台电脑上。下面的清除不影响钥匙和设置。</p>
      <SetList>
        <SetRow title="这一页" hint={tabId === null ? '从扩展选项进来时不知道你在读哪一页，请到那一页的侧栏里清。' : '清掉当前页的摘要、对话和 AI 问记录。'}>
          {tabId !== null ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => void run({ type: 'clearSession', tabId })}>
              清掉这一页
            </button>
          ) : (
            <span className="set-row-hint">到侧栏里操作</span>
          )}
        </SetRow>
        <SetRow title="所有页面" hint="关浏览器本来也会清。现在立刻清。">
          <button type="button" className="danger" disabled={busy} onClick={() => void run({ type: 'clearAllSessions' })}>
            全部清掉
          </button>
        </SetRow>
      </SetList>
    </Section>
  );
}

function About() {
  const version = browser.runtime.getManifest().version;
  return (
    <Section title="关于与帮助">
      <p className="hint">WebKnow AI（webknow-ai）{version}：读网页时随叫随到的导师。哪里不懂，划哪里。</p>
      <p className="hint">
        使用说明见{' '}
        <a href="https://github.com/wasteball/webknow-ai#readme" target="_blank" rel="noreferrer">
          项目主页
        </a>
        。
      </p>
    </Section>
  );
}
