import { useEffect, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';

import { ANSWER_DEFAULT_POLICY } from '../../core/prompts/answer';
import { GUIDE_DEFAULT_POLICY, summaryCharsFor } from '../../core/prompts/guide';
import { LEARN_DEFAULT_POLICY } from '../../core/prompts/learn';
import type { Command, PanelState, Reply } from '../../core/protocol';
import type { PromptTarget } from '../../core/settings';
import { BUILTIN_SKILLS, type Skill } from '../../core/skills';
import { BUILTIN_SEARCH_PROVIDERS } from '../../core/search/registry';
import { Notice, Section } from './bits';
import { BrandMark, Icon, type IconName } from './Icon';
import { ModelSettings as ModelAndKey } from './ModelSettings';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 设置（F2 / 2026-09-19 反馈改版）：整页界面，渲染在独立标签页里（entrypoints/options）。
 * 左侧分类导航 + 右侧内容区，像常规软件的设置窗——改配置不是阅读，不占用侧栏。
 * 非敏感设置统一走 saveSettings；Key 仍是独立命令与独立校验。
 * 清除这一页、清除全部、删掉钥匙、恢复默认提示词，互不牵连（FR-033）。
 */

type CategoryId = 'general' | 'model' | 'prompts' | 'search' | 'ima' | 'data' | 'about';

const CATEGORIES: { id: CategoryId; label: string; icon: IconName }[] = [
  { id: 'general', label: '阅读', icon: 'book' },
  { id: 'model', label: '模型', icon: 'cpu' },
  { id: 'prompts', label: '提示词', icon: 'file' },
  { id: 'search', label: '联网搜索', icon: 'globe' },
  { id: 'ima', label: '知识库', icon: 'cloud' },
  { id: 'data', label: '清除', icon: 'grid' },
  { id: 'about', label: '关于', icon: 'info' },
];

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

const PROMPT_TARGETS: { key: PromptTarget; title: string; hint: string }[] = [
  {
    key: 'guide',
    title: '导读摘要',
    hint: '决定“这篇文章讲了什么”怎么写、给几个话题。',
  },
  {
    key: 'answer',
    title: '问 AI',
    hint: '决定回答的口径与风格。',
  },
  {
    key: 'learn',
    title: 'AI 问',
    hint: '决定它出什么题、怎么回应你的回答。',
  },
];

const TARGET_LABEL: Record<PromptTarget, string> = {
  guide: '导读摘要',
  answer: '问 AI',
  learn: 'AI 问',
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
  const [category, setCategory] = useState<CategoryId>(() => {
    const id = location.hash.replace(/^#/, '');
    return CATEGORIES.some((item) => item.id === id) ? (id as CategoryId) : 'general';
  });

  return (
    <div className="settings-page">
      {/* 导航在窄屏会变成可横向滚动的长条，所以给键盘用户一条直通正文的捷径。 */}
      <a className="skip-link" href="#settings-content">
        跳到设置内容
      </a>
      <header className="settings-topbar">
        <p className="settings-brand">
          <BrandMark size={24} />
          知伴
        </p>
        <p className="settings-tagline">设置</p>
      </header>
      <div className="settings-shell">
        <nav className="settings-nav" aria-label="设置分类">
          {CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={category === item.id ? 'true' : undefined}
              onClick={() => setCategory(item.id)}
            >
              <Icon name={item.icon} small />
              {item.label}
            </button>
          ))}
        </nav>
        <main className="settings-content" id="settings-content" tabIndex={-1}>
          {notice && <Notice text={notice} onDismiss={onDismissNotice} />}
          {category === 'general' && <ReadingPrefs state={state} send={send} />}
          {category === 'model' && <ModelAndKey state={state} send={send} />}
          {category === 'prompts' && (
            <>
              <Prompts state={state} send={send} />
              <Skills state={state} send={send} />
            </>
          )}
          {category === 'search' && <SearchSettings state={state} send={send} />}
          {category === 'ima' && <ImaSettings state={state} send={send} />}
          {category === 'data' && <Cleanup state={state} send={send} />}
          {category === 'about' && <About />}
        </main>
      </div>
    </div>
  );
}

/**
 * 提示词（2026-09-27 改版）：一块一个编辑框，框里就是正在生效的那段话。
 *
 * 从前这里是「默认 / 一排模板 / 自己写」的单选：选了模板，生效的东西变了，
 * 屏幕上一个字都没变——用户只能得出「选了没反应」。现在模板不再是一个隐藏的
 * 生效来源，它只是「把这份写法填进来」的按钮；填进来之后可以接着改。
 * 看到的 = 生效的，只有一个来源。
 */
function Prompts({ state, send }: { state: PanelState; send: Send }) {
  const { settings } = state;

  const defaults: Record<PromptTarget, string> = {
    guide: GUIDE_DEFAULT_POLICY({
      maxBubbles: settings.maxBubbles,
      summaryMaxChars: summaryCharsFor(settings.summaryLength),
    }),
    answer: ANSWER_DEFAULT_POLICY,
    learn: LEARN_DEFAULT_POLICY,
  };

  return (
    <Section title="提示词">
      <p className="hint">
        每一块下面那段话就是它现在照着做的事。直接改、存下来就换成你的写法；想回到出厂那份，点「恢复默认」。
        发给谁、怎么收费、输出什么格式仍由程序管，改这里改不动。
      </p>
      {PROMPT_TARGETS.map((target) => (
        <PromptCard
          key={target.key}
          target={target}
          fallback={defaults[target.key]}
          saved={settings.prompts[target.key] ?? ''}
          templates={[...BUILTIN_SKILLS, ...settings.customSkills].filter(
            (skill) => skill.target === target.key,
          )}
          send={send}
        />
      ))}
    </Section>
  );
}

function PromptCard({
  target,
  fallback,
  saved,
  templates,
  send,
}: {
  target: { key: PromptTarget; title: string; hint: string };
  /** 没存过自己的写法时，用的是这份内置默认。 */
  fallback: string;
  saved: string;
  templates: Skill[];
  send: Send;
}) {
  const inEffect = saved || fallback;
  const [draft, setDraft] = useState(inEffect);
  const [busy, setBusy] = useState(false);
  // 别处（比如恢复默认、或另一个设置页）改过之后，跟上新的生效内容；
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
        <p>{target.hint}</p>
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
      {templates.length > 0 && (
        <details>
          <summary className="link">换一种现成写法（{templates.length} 份）</summary>
          <ul className="skill-list">
            {templates.map((template) => (
              <li key={template.id}>
                <p className="skill-name">
                  {template.name}
                  <button type="button" disabled={busy} onClick={() => setDraft(template.body)}>
                    填进上面
                  </button>
                </p>
                <p className="hint">{template.description || '（没有说明）'}</p>
              </li>
            ))}
          </ul>
          <p className="hint">填进来只是起草，可以接着改；点保存才生效。</p>
        </details>
      )}
    </article>
  );
}

/** 我的写法模板：把常用写法存下来，之后在上面「换一种现成写法」里直接填进编辑框。 */
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
    <Section title="我的写法模板">
      <p className="hint">存下来的写法会出现在上面每一块的「换一种现成写法」里，点一下就填进编辑框。</p>
      <ul className="skill-list">
        {customs.length === 0 && !adding && <li className="hint">还没有自己存的模板。</li>}
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
          <label htmlFor="skill-name">模板名称</label>
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
            <option value="guide">导读摘要</option>
            <option value="answer">问 AI</option>
            <option value="learn">AI 问</option>
          </select>
          <label htmlFor="skill-description">一句话说明（可选）</label>
          <input
            id="skill-description"
            type="text"
            maxLength={200}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <label htmlFor="skill-body">模板内容（怎么干活的说明）</label>
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
              保存模板
            </button>
            <button type="button" className="secondary" onClick={() => setAdding(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="composer-actions">
          <button type="button" className="secondary" onClick={() => setAdding(true)}>
            添加模板
          </button>
        </div>
      )}
    </Section>
  );
}

function SearchSettings({ state, send }: { state: PanelState; send: Send }) {
  const current = state.settings.search;
  const [providerId, setProviderId] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const selected = BUILTIN_SEARCH_PROVIDERS.find((provider) => provider.id === providerId);

  const run = async (command: Command) => {
    setBusy(true);
    const reply = await send(command);
    setBusy(false);
    return reply;
  };

  /** 启用：先在用户手势里申请 host 权限（必须第一个发出、前面不能有 await），再保存并测试。 */
  const enable = async () => {
    if (!selected) return;
    const hosts = selected.hosts(credentials);
    try {
      const granted = hosts.length ? await browser.permissions.request({ origins: hosts }) : true;
      if (!granted) {
        setHint('没有授予搜索服务的访问权限，什么都没有保存。可以稍后再试。');
        return;
      }
    } catch {
      setHint('浏览器没有弹出授权窗口。请关掉侧栏重新打开后再点一次。');
      return;
    }
    const reply = await run({ type: 'saveSearchConfig', providerId: selected.id, credentials });
    if (reply?.ok) await run({ type: 'testSearch', providerId: selected.id });
  };

  const pick = (id: string) => {
    setProviderId(id);
    setCredentials({});
    setHint(null);
  };

  return (
    <Section title="联网搜索">
      <p className="hint">
        打开「问 AI」里的联网开关，只把搜索词发出去，正文仍只给模型。免费的不用注册。
      </p>
      {current.enabled && (
        <p className="status-banner">现在用 {current.providerName}。换一家先点下面一张卡。</p>
      )}
      <div className="choice-grid" role="radiogroup" aria-label="搜索服务">
        <button
          type="button"
          role="radio"
          className="choice-card"
          aria-checked={!providerId}
          disabled={busy}
          onClick={() => pick('')}
        >
          <strong>先不查网上</strong>
          <span>只根据这一页回答</span>
        </button>
        {BUILTIN_SEARCH_PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            role="radio"
            className="choice-card"
            aria-checked={providerId === provider.id}
            disabled={busy}
            onClick={() => pick(provider.id)}
          >
            <strong>
              {provider.name}
              {!provider.configFields.length ? ' · 免费' : ''}
            </strong>
            <span>{provider.description}</span>
          </button>
        ))}
      </div>
      {selected && (
        <>
          <p className="hint">{selected.description}</p>
          {!selected.configFields.length && (
            <p className="hint">
              这个不用注册也不用填任何东西。它直接读对方的搜索结果页，所以对方改版时可能失效——
              真失效了，回答会照实说“这次只依据文章本身”，不会拿别的东西充数。
            </p>
          )}
          {selected.configFields.map((field) => (
            <div className="field" key={field.key}>
              <label htmlFor={`search-${field.key}`}>{field.label}</label>
              <input
                id={`search-${field.key}`}
                type={field.type}
                autoComplete="off"
                spellCheck={false}
                placeholder={field.placeholder}
                value={credentials[field.key] ?? ''}
                onChange={(event) =>
                  setCredentials((currentValues) => ({ ...currentValues, [field.key]: event.target.value }))
                }
              />
            </div>
          ))}
          {hint && <p className="hint">{hint}</p>}
          <div className="composer-actions">
            <button type="button" disabled={busy} onClick={() => void enable()}>
              授权并启用
            </button>
          </div>
          <p className="hint">
            点“授权并启用”后浏览器会先问你是否允许访问这个搜索服务的地址。启用后会自动试搜一次。
          </p>
        </>
      )}
      {current.enabled && (
        <div className="composer-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void run({ type: 'saveSearchConfig', providerId: null })}
          >
            停用联网搜索（当前：{current.providerName}）
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
      <p className="hint">扫码只登录 ima 官网；若要让知伴访问知识库，还需配置开放接口凭证。</p>
      <p className="hint">开放接口连接用于选择默认知识库；侧栏保存入口仍在联调。</p>
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
      <PageLead title="阅读" lead="摘要多长、它怎么问你、字大不大。改完立刻生效。" />
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
        <SetRow title="话题条" hint="摘要下面那几张可点的卡片。">
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
    <Section title="清除">
      <p className="hint">摘要和对话只在这次打开浏览器时留着。钥匙和设置不受影响。</p>
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
    <Section title="关于">
      <p className="hint">知伴（webknow-ai）{version}：在当前网页旁，帮你看懂文章、发现问题，并通过双向对话检验理解。</p>
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
