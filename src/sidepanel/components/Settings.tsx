import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

import { KNOWN_MODELS } from '../../core/deepseek';
import { ANSWER_DEFAULT_POLICY } from '../../core/prompts/answer';
import { GUIDE_DEFAULT_POLICY, summaryCharsFor } from '../../core/prompts/guide';
import { LEARN_DEFAULT_POLICY } from '../../core/prompts/learn';
import type { Command, PanelState, Reply } from '../../core/protocol';
import type { PromptTarget } from '../../core/settings';
import { BUILTIN_SKILLS } from '../../core/skills';
import { BUILTIN_SEARCH_PROVIDERS } from '../../core/search/registry';
import { Section } from './bits';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 设置页（产品化改造 F2）：分区展示——模型与钥匙、提示词、行为偏好、外观、内容清理、关于。
 * 非敏感设置统一走 saveSettings；Key 仍是独立命令与独立校验。
 * 清除这一页、清除全部、删掉钥匙、恢复默认提示词，互不牵连（FR-033）。
 */

const PROMPT_TARGETS: { key: PromptTarget; title: string; hint: string }[] = [
  {
    key: 'guide',
    title: '导读摘要',
    hint: '决定“这篇文章讲了什么”怎么写、给几个话题。',
  },
  {
    key: 'answer',
    title: '自由问答',
    hint: '决定回答的口径与风格。',
  },
  {
    key: 'learn',
    title: '“AI 问我”怎么提问',
    hint: '决定它出什么题、怎么回应你的回答。',
  },
];

const TARGET_LABEL: Record<PromptTarget, string> = {
  guide: '导读摘要',
  answer: '自由问答',
  learn: 'AI 问我',
};

export function Settings({ state, send }: { state: PanelState; send: Send }) {
  return (
    <>
      <ModelAndKey state={state} send={send} />
      <Prompts state={state} send={send} />
      <Skills state={state} send={send} />
      <SearchSettings state={state} send={send} />
      <Behavior state={state} send={send} />
      <Appearance state={state} send={send} />
      <Cleanup state={state} send={send} />
      <About />
    </>
  );
}

function ModelAndKey({ state, send }: { state: PanelState; send: Send }) {
  const { settings } = state;
  const [models, setModels] = useState<string[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customModel, setCustomModel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (command: Command) => {
    setBusy(true);
    const reply = await send(command);
    setBusy(false);
    return reply;
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      const reply = await send({ type: 'listModels' });
      if (!alive) return;
      if (reply?.ok && reply.data?.models?.length) setModels(reply.data.models);
      else setLoadFailed(true);
    })();
    return () => {
      alive = false;
    };
    // 只在进入设置页时拉一次模型列表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const known = models ?? KNOWN_MODELS;
  const modelInList = known.includes(settings.model);

  return (
    <Section title="模型与钥匙">
      <p className="hint">
        这个插件用你自己的 DeepSeek 账号干活。钥匙只存在这个浏览器里，不会同步，也发不给我们。
      </p>

      <div className="field">
        <label htmlFor="model-select">模型</label>
        {customMode ? (
          <>
            <input
              id="model-select"
              type="text"
              spellCheck={false}
              placeholder={settings.model}
              value={customModel}
              onChange={(event) => setCustomModel(event.target.value)}
            />
            <div className="composer-actions">
              <button
                type="button"
                disabled={busy || !customModel.trim()}
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
            id="model-select"
            value={modelInList ? settings.model : '__custom__'}
            disabled={busy}
            onChange={(event) => {
              if (event.target.value === '__custom__') setCustomMode(true);
              else void run({ type: 'saveSettings', patch: { model: event.target.value } });
            }}
          >
            {!modelInList && <option value={settings.model}>{settings.model}（当前）</option>}
            {known.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
            <option value="__custom__">手动填写…</option>
          </select>
        )}
        {loadFailed && <p className="hint">没能取得完整模型列表，可以手动填写模型 ID。</p>}
      </div>

      <div className="field">
        <label htmlFor="replace-key">{state.hasKey ? '换一把新钥匙' : 'DeepSeek 钥匙'}</label>
        <input
          id="replace-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <div className="composer-actions">
          <button
            type="button"
            disabled={busy || !key.trim()}
            onClick={() => void run({ type: 'saveKey', key }).then(() => setKey(''))}
          >
            保存并确认能用
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !key.trim()}
            onClick={() => void run({ type: 'testKey', key })}
          >
            只试试连得上不
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy || !state.hasKey}
            onClick={() => void run({ type: 'deleteKey' })}
          >
            删掉钥匙
          </button>
        </div>
        <p className="hint">
          {state.hasKey ? '已经保存了一把钥匙。' : '还没有填钥匙。'}
          删掉钥匙不会清掉你读过的内容，也不会动下面的设置。
        </p>
      </div>
    </Section>
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
        return (
          <div className="field" key={key}>
            <label htmlFor={`preset-${key}`}>{title}</label>
            <p className="hint">{hint}</p>
            <select
              id={`preset-${key}`}
              value={custom ? '__custom__' : chosen || '__default__'}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                if (value === '__custom__' || value === '__default__') {
                  void run({ type: 'saveSettings', patch: { skillChoices: { [key]: '' } } });
                } else {
                  void run({ type: 'saveSettings', patch: { skillChoices: { [key]: value } } });
                }
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
            {custom && (
              <>
                <textarea
                  id={`prompt-${key}`}
                  rows={6}
                  maxLength={8000}
                  value={drafts[key]}
                  placeholder="留空就用上面选的写法。"
                  onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                />
                <div className="composer-actions">
                  <button
                    type="button"
                    disabled={busy || drafts[key].trim() === custom}
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
                      void run({ type: 'saveSettings', patch: { prompts: { [key]: '' } } });
                    }}
                  >
                    清掉我的写法
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
            <option value="answer">自由问答</option>
            <option value="learn">AI 问我</option>
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
        拿到结果后连同文章一起回答。**只发搜索词，不发文章正文。**搜索服务按它自己的规则收费或免费。
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
              {provider.name}
            </option>
          ))}
          {current.enabled && <option value="已启用">已启用：{current.providerName}</option>}
        </select>
      </div>
      {selected && (
        <>
          <p className="hint">{selected.description}</p>
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
        <label htmlFor="learning-budget">“AI 问我”一轮最多问几个问题</label>
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
        <label htmlFor="learning-style">“AI 问我”怎么出题</label>
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
        <button
          type="button"
          className="secondary"
          disabled={busy || state.tabId === null}
          onClick={() => state.tabId !== null && void run({ type: 'clearSession', tabId: state.tabId })}
        >
          清掉这一页的内容
        </button>
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
