import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

import { ANSWER_DEFAULT_POLICY } from '../../core/prompts/answer';
import { GUIDE_DEFAULT_POLICY, summaryCharsFor } from '../../core/prompts/guide';
import { LEARN_DEFAULT_POLICY } from '../../core/prompts/learn';
import type { Command, PanelState, Reply } from '../../core/protocol';
import { MODEL_PROVIDERS, type ModelProvider } from '../../core/model-providers';
import type { PromptTarget } from '../../core/settings';
import { BUILTIN_SKILLS } from '../../core/skills';
import { BUILTIN_SEARCH_PROVIDERS } from '../../core/search/registry';
import { Notice, Section } from './bits';
import { BrandMark, Icon, type IconName } from './Icon';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 设置（F2 / 2026-09-19 反馈改版）：整页界面，渲染在独立标签页里（entrypoints/options）。
 * 左侧分类导航 + 右侧内容区，像常规软件的设置窗——改配置不是阅读，不占用侧栏。
 * 非敏感设置统一走 saveSettings；Key 仍是独立命令与独立校验。
 * 清除这一页、清除全部、删掉钥匙、恢复默认提示词，互不牵连（FR-033）。
 */

type CategoryId = 'general' | 'model' | 'prompts' | 'skills' | 'search' | 'ima' | 'data' | 'about';

// 分类带图标（照原型）。原型在窄屏会把文字隐藏、只留图标，这里不跟：
// 读者是普通用户，一排认不出的图形比窄一点更糟。
const CATEGORIES: { id: CategoryId; label: string; icon: IconName }[] = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'model', label: '模型', icon: 'cpu' },
  { id: 'prompts', label: '提示词', icon: 'file' },
  { id: 'skills', label: '技能', icon: 'puzzle' },
  { id: 'search', label: '联网搜索', icon: 'globe' },
  { id: 'ima', label: '知识库', icon: 'cloud' },
  { id: 'data', label: '数据', icon: 'grid' },
  { id: 'about', label: '关于', icon: 'info' },
];

const PROMPT_TARGETS: { key: PromptTarget; title: string; hint: string }[] = [
  {
    key: 'guide',
    title: '导读摘要',
    hint: '决定“这篇文章讲了什么”怎么写、给几个话题。',
  },
  {
    key: 'answer',
    title: '我问',
    hint: '决定回答的口径与风格。',
  },
  {
    key: 'learn',
    title: '问我',
    hint: '决定它出什么题、怎么回应你的回答。',
  },
];

const TARGET_LABEL: Record<PromptTarget, string> = {
  guide: '导读摘要',
  answer: '我问',
  learn: '问我',
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
  const [category, setCategory] = useState<CategoryId>('general');

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
        <p className="settings-tagline">能力设置</p>
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
          {category === 'general' && (
            <>
              <Behavior state={state} send={send} />
              <Appearance state={state} send={send} />
            </>
          )}
          {category === 'model' && <ModelAndKey state={state} send={send} />}
          {category === 'prompts' && <Prompts state={state} send={send} />}
          {category === 'skills' && <Skills state={state} send={send} />}
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
 * 模型供应商（2026-09-19 加入第二家；布局照原型 companion-ai-prototype.html）。
 *
 * 两张卡片同时摆出来，各自独立配置——不是"先选一家再配它"。
 * 每张卡自己带状态、当前模型和配置区，谁在用一眼看得出。
 * 每家的钥匙与模型分开存：来回换不会互相覆盖，也不会把 A 家的钥匙发给 B 家。
 */
function ModelAndKey({ state, send }: { state: PanelState; send: Send }) {
  const { settings } = state;
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (command: Command) => {
    setBusy(command.type);
    const reply = await send(command);
    setBusy(null);
    return reply;
  };

  return (
    <Section title="模型供应商">
      <p className="hint">
        用哪家就是把这页文字发给哪家。两家的钥匙和模型分开存，来回换不会互相覆盖；
        换一家之后，下一次开始伴读会重新问你确认（因为接收方变了）。
      </p>
      <div className="provider-grid">
        {MODEL_PROVIDERS.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            state={state}
            busy={busy}
            run={run}
          />
        ))}
      </div>
    </Section>
  );
}

function ProviderCard({
  provider,
  state,
  busy,
  run,
}: {
  provider: ModelProvider;
  state: PanelState;
  busy: string | null;
  run: (command: Command) => Promise<Reply | undefined>;
}) {
  const { settings } = state;
  const connected = settings.providerKeys[provider.id] === true;
  const active = settings.provider === provider.id;
  const [models, setModels] = useState<string[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customModel, setCustomModel] = useState('');
  const [key, setKey] = useState('');
  const anyBusy = busy !== null;

  // 接上之后才拉模型列表；断开就把列表清掉，免得留下过期的选项。
  useEffect(() => {
    setModels(null);
    setLoadFailed(false);
    setKey('');
    if (!connected) return;
    let alive = true;
    void (async () => {
      const reply = await run({ type: 'listModels', provider: provider.id });
      if (!alive) return;
      if (reply?.ok && reply.data?.models?.length) setModels(reply.data.models);
      else setLoadFailed(true);
    })();
    return () => {
      alive = false;
    };
    // run 是稳定引用；只在"接上了没有"变化时重新拉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, provider.id]);

  const known = models ?? provider.knownModels;
  const model = settings.models[provider.id] ?? provider.defaultModel;
  const modelInList = known.includes(model);
  const status = active ? (connected ? '使用中' : '使用中·未连接') : connected ? '已连接' : '未配置';

  /** 保存钥匙并切到这家：一次点击完成"能用"与"在用"。 */
  const connectAndUse = async () => {
    const saved = await run({ type: 'saveKey', provider: provider.id, key });
    if (!saved?.ok) return;
    setKey('');
    await run({ type: 'saveSettings', patch: { provider: provider.id } });
  };

  return (
    <article className={`provider-card${active ? ' active' : ''}`}>
      <div className="provider-head">
        <span className="provider-logo" style={{ background: provider.logoColor }} aria-hidden="true">
          {provider.logoChar}
        </span>
        <div className="provider-copy">
          <h3>{provider.name}</h3>
          <p>{provider.tagline}</p>
        </div>
        <span className={`status-pill${active && connected ? ' ready' : ''}`}>{status}</span>
      </div>

      <div className="provider-meta">
        <div>
          <span>模型</span>
          <strong>{connected ? model : provider.defaultModel}</strong>
        </div>
        <div>
          <span>钥匙</span>
          <strong>{connected ? '已保存' : '未填写'}</strong>
        </div>
      </div>

      {!connected ? (
        <div className="provider-config">
          <div className="field">
            <label htmlFor={`key-${provider.id}`}>
              {provider.name} 的钥匙（{provider.keyHint}）
            </label>
            <input
              id={`key-${provider.id}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </div>
          <div className="composer-actions">
            <button type="button" disabled={anyBusy || !key.trim()} onClick={() => void connectAndUse()}>
              {busy === 'saveKey' ? '正在确认这把钥匙…' : '保存并启用'}
            </button>
          </div>
          <p className="hint">
            保存时会先试连一次，确认钥匙能用——试连不发送你正在看的网页，但会有极少量费用。
            还没有钥匙？到{' '}
            <a href={provider.keyPage} target="_blank" rel="noreferrer">
              {provider.name} 的钥匙页面
            </a>{' '}
            创建一个。
          </p>
        </div>
      ) : (
        <div className="provider-config">
          <div className="field">
            <label htmlFor={`model-${provider.id}`}>用哪个模型</label>
            {customMode ? (
              <>
                <input
                  id={`model-${provider.id}`}
                  type="text"
                  spellCheck={false}
                  placeholder={model}
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                />
                <div className="composer-actions">
                  <button
                    type="button"
                    disabled={anyBusy || !customModel.trim()}
                    onClick={() =>
                      void run({ type: 'saveSettings', patch: { model: customModel.trim() } }).then(() => {
                        setCustomModel('');
                        setCustomMode(false);
                      })
                    }
                  >
                    保存模型
                  </button>
                  <button type="button" className="secondary" onClick={() => setCustomMode(false)}>
                    取消
                  </button>
                </div>
              </>
            ) : (
              <select
                id={`model-${provider.id}`}
                value={modelInList ? model : '__custom__'}
                disabled={anyBusy}
                onChange={(event) => {
                  if (event.target.value === '__custom__') setCustomMode(true);
                  else void run({ type: 'saveSettings', patch: { model: event.target.value } });
                }}
              >
                {!modelInList && <option value={model}>{model}（当前）</option>}
                {known.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
                <option value="__custom__">手动填写…</option>
              </select>
            )}
            <p className="hint">
              换模型只影响之后的请求，已经读出来的内容不动。
              {loadFailed && ' 没能取得完整模型列表，可以手动填写模型 ID。'}
            </p>
          </div>

          <div className="field">
            <label htmlFor={`replace-${provider.id}`}>换一把新钥匙</label>
            <input
              id={`replace-${provider.id}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <div className="composer-actions">
              <button
                type="button"
                disabled={anyBusy || !key.trim()}
                onClick={() =>
                  void run({ type: 'saveKey', provider: provider.id, key }).then(() => setKey(''))
                }
              >
                保存并确认能用
              </button>
              {!active && (
                <button
                  type="button"
                  className="secondary"
                  disabled={anyBusy}
                  onClick={() => void run({ type: 'saveSettings', patch: { provider: provider.id } })}
                >
                  改用这家
                </button>
              )}
              <button
                type="button"
                className="danger"
                disabled={anyBusy}
                onClick={() => void run({ type: 'deleteKey', provider: provider.id })}
              >
                断开并删掉钥匙
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function Prompts({ state, send }: { state: PanelState; send: Send }) {
  const { settings } = state;
  const [drafts, setDrafts] = useState<Record<PromptTarget, string>>({
    guide: settings.prompts.guide ?? '',
    answer: settings.prompts.answer ?? '',
    learn: settings.prompts.learn ?? '',
  });
  const [busy, setBusy] = useState(false);
  /**
   * “自己写”是一个覆盖层，不是第三套预设：选中它只切换这一块显示什么，
   * 不丢掉上面选好的技能——把自写内容清掉时还能落回那套技能。
   * 未保存过自写内容时也要能打开输入框，否则这个选项点了没有任何反应（曾经的缺陷）。
   */
  const [writing, setWriting] = useState<Record<string, boolean>>({});

  const run = async (command: Command) => {
    setBusy(true);
    await send(command);
    setBusy(false);
  };

  const defaults: Record<PromptTarget, string> = {
    guide: GUIDE_DEFAULT_POLICY({ maxBubbles: settings.maxBubbles, summaryMaxChars: summaryCharsFor(settings.summaryLength) }),
    answer: ANSWER_DEFAULT_POLICY,
    learn: LEARN_DEFAULT_POLICY,
  };

  const skillsFor = (target: PromptTarget) =>
    [...BUILTIN_SKILLS, ...settings.customSkills].filter((skill) => skill.target === target);

  return (
    <Section title="提示词">
      <p className="hint">
        每个板块都可以选一套预设写法（技能），或完全自己写。自己写的内容优先于预设；
        安全边界不受影响：内容的去向、费用上限和输出格式仍由程序控制。
      </p>
      {PROMPT_TARGETS.map(({ key, title, hint }) => {
        const chosen = settings.skillChoices[key] ?? '';
        const custom = settings.prompts[key] ?? '';
        const isWriting = writing[key] ?? Boolean(custom);
        return (
          <div className="field" key={key}>
            <label htmlFor={`preset-${key}`}>{title}</label>
            <p className="hint">{hint}</p>
            <select
              id={`preset-${key}`}
              value={isWriting ? '__custom__' : chosen || '__default__'}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                setWriting((current) => ({ ...current, [key]: value === '__custom__' }));
                if (value === '__custom__') return;
                void run({ type: 'saveSettings', patch: { skillChoices: { [key]: value === '__default__' ? '' : value } } });
              }}
            >
              <option value="__default__">默认写法</option>
              {skillsFor(key).map((skill) => (
                <option key={skill.id} value={skill.id}>
                  技能：{skill.name}
                </option>
              ))}
              <option value="__custom__">自己写（优先于预设）</option>
            </select>
            {isWriting && (
              <>
                <textarea
                  id={`prompt-${key}`}
                  aria-label={`${title}：我自己写的写法`}
                  rows={6}
                  maxLength={8000}
                  value={drafts[key]}
                  placeholder="写你希望它怎么写。保存后会盖过上面选的写法。"
                  onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                />
                <div className="composer-actions">
                  <button
                    type="button"
                    disabled={busy || !drafts[key].trim() || drafts[key].trim() === custom}
                    onClick={() => void run({ type: 'saveSettings', patch: { prompts: { [key]: drafts[key] } } })}
                  >
                    保存我的写法
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setDrafts((current) => ({ ...current, [key]: '' }));
                      setWriting((current) => ({ ...current, [key]: false }));
                      if (custom) void run({ type: 'saveSettings', patch: { prompts: { [key]: '' } } });
                    }}
                  >
                    {custom ? '清掉我的写法' : '取消'}
                  </button>
                </div>
              </>
            )}
            <details>
              <summary className="link">看看当前生效的是什么</summary>
              <p className="hint">{custom || defaults[key]}</p>
            </details>
          </div>
        );
      })}
    </Section>
  );
}

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
    <Section title="技能">
      <p className="hint">
        技能是一套现成的写法。内置的随插件更新；下面的自定义技能可以把你自己的用法存成模板。
      </p>
      <ul className="skill-list">
        {BUILTIN_SKILLS.map((skill) => (
          <li key={skill.id}>
            <p className="skill-name">
              {skill.name}
              <span className="tag">{TARGET_LABEL[skill.target]}</span>
            </p>
            <p className="hint">{skill.description}</p>
          </li>
        ))}
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
          <label htmlFor="skill-name">技能名称</label>
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
            <option value="answer">我问</option>
            <option value="learn">问我</option>
          </select>
          <label htmlFor="skill-description">一句话说明（可选）</label>
          <input
            id="skill-description"
            type="text"
            maxLength={200}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <label htmlFor="skill-body">技能内容（怎么干活的说明）</label>
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
              保存技能
            </button>
            <button type="button" className="secondary" onClick={() => setAdding(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="composer-actions">
          <button type="button" className="secondary" onClick={() => setAdding(true)}>
            添加自定义技能
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

  return (
    <Section title="联网搜索">
      <p className="hint">
        启用后，问答里会多一个“联网搜索”开关：打开它提问，会把你的搜索词发给下面选的搜索服务，
        拿到结果后连同文章一起回答。<strong>只发搜索词，不发文章正文。</strong>
        搜索服务和模型钥匙是分开的，换任何模型都不影响它。
      </p>
      <div className="field">
        <label htmlFor="search-provider">搜索服务</label>
        <select
          id="search-provider"
          value={providerId || (current.enabled ? '已启用' : '')}
          disabled={busy}
          onChange={(event) => setProviderId(event.target.value)}
        >
          <option value="">不启用{current.enabled ? '（当前已启用，更改请先选择）' : ''}</option>
          {BUILTIN_SEARCH_PROVIDERS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {/* 免 Key 的标在选项上：一眼看出哪个不用注册就能用。 */}
              {provider.configFields.length ? provider.name : `${provider.name}（免费，无需注册）`}
            </option>
          ))}
          {current.enabled && <option value="已启用">已启用：{current.providerName}</option>}
        </select>
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
      <p className="hint">
        可以先在这里填好凭证、选好默认知识库。侧栏里的“存入知识库”这一步还在收尾，本版先不开入口，
        避免存进去的笔记对不上所选知识库。凭证会留在本机，下一版开放保存时直接用。
      </p>
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
            <label htmlFor="ima-client-id">Client ID</label>
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
            <label htmlFor="ima-api-key">API Key</label>
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

function Behavior({ state, send }: { state: PanelState; send: Send }) {
  const { settings } = state;
  const [busy, setBusy] = useState(false);

  const change = (patch: Parameters<typeof send>[0]) => {
    if (patch.type !== 'saveSettings') return;
    setBusy(true);
    void send(patch).finally(() => setBusy(false));
  };

  return (
    <Section title="行为偏好">
      <p className="hint">这些只影响你的使用体验，改动立即生效并保存。</p>
      <div className="field">
        <label htmlFor="learning-budget">「问我」一轮最多问几个问题</label>
        <select
          id="learning-budget"
          value={String(settings.learningBudget)}
          disabled={busy}
          onChange={(event) => change({ type: 'saveSettings', patch: { learningBudget: Number(event.target.value) } })}
        >
          {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
            <option key={count} value={String(count)}>
              {count} 个
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="learning-style">「问我」怎么出题</label>
        <select
          id="learning-style"
          value={settings.learningStyle}
          disabled={busy}
          onChange={(event) =>
            change({
              type: 'saveSettings',
              patch: { learningStyle: event.target.value as 'mixed' | 'quiz' | 'open' },
            })
          }
        >
          <option value="mixed">自动（按内容选择，默认）</option>
          <option value="quiz">总是出选择题</option>
          <option value="open">总是让我用自己的话答</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="summary-length">摘要长度</label>
        <select
          id="summary-length"
          value={settings.summaryLength}
          disabled={busy}
          onChange={(event) =>
            change({
              type: 'saveSettings',
              patch: { summaryLength: event.target.value as 'short' | 'medium' | 'long' },
            })
          }
        >
          <option value="short">短（两三句话）</option>
          <option value="medium">中（默认）</option>
          <option value="long">长（多讲一些）</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="max-bubbles">话题卡片数量上限</label>
        <select
          id="max-bubbles"
          value={String(settings.maxBubbles)}
          disabled={busy}
          onChange={(event) => change({ type: 'saveSettings', patch: { maxBubbles: Number(event.target.value) } })}
        >
          {Array.from({ length: 4 }, (_, index) => index).map((count) => (
            <option key={count} value={String(count)}>
              {count === 0 ? '不给话题卡片' : `最多 ${count} 个`}
            </option>
          ))}
        </select>
      </div>
    </Section>
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
    <Section title="外观">
      <div className="field">
        <label htmlFor="font-size">文字大小</label>
        <select
          id="font-size"
          value={settings.fontSize}
          disabled={busy}
          onChange={(event) =>
            change({ type: 'saveSettings', patch: { fontSize: event.target.value as 'normal' | 'large' } })
          }
        >
          <option value="normal">标准</option>
          <option value="large">大</option>
        </select>
      </div>
    </Section>
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
    <Section title="内容保留与清理">
      <p className="hint">
        你读过的网页文字、摘要、对话和学习记录，只在这次浏览器开着的时候保留：
        关掉标签页就清掉那一页，关掉浏览器就全部清掉。钥匙和上面的设置不受影响。
      </p>
      <div className="composer-actions">
        {/* 从浏览器自带的“扩展选项”进来时不知道你在读哪一页：给一句说明，不留一个禁用按钮。 */}
        {tabId !== null ? (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void run({ type: 'clearSession', tabId })}
          >
            清掉这一页的内容
          </button>
        ) : (
          <p className="hint">想只清掉某一页？在那一页的侧栏里点“清掉这一页的内容”。</p>
        )}
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void run({ type: 'clearAllSessions' })}
        >
          清掉所有页面的内容
        </button>
      </div>
      <p className="hint">这两个操作都不会删掉钥匙，也不会改上面的设置。</p>
    </Section>
  );
}

function About() {
  const version = browser.runtime.getManifest().version;
  return (
    <Section title="关于">
      <p className="hint">
        webknow-ai 版本 {version}。使用说明与常见问题见{' '}
        <a href="https://github.com/wasteball/webknow-ai#readme" target="_blank" rel="noreferrer">
          项目主页
        </a>
        。
      </p>
    </Section>
  );
}
