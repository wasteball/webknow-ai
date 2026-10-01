import { useState } from 'react';
import { browser } from 'wxt/browser';
import type { AgentSettings } from '../../core/search/agent-types';
import type { Command, PanelState, Reply } from '../../core/protocol';
import { BUILTIN_SEARCH_PROVIDERS } from '../../core/search/registry';
import { DEFAULT_SEARCH_AGENT_POLICY, SEARCH_AGENT_VERSION } from '../../core/prompts/search-agent';
import { outboundReceiverLines } from '../outbound-copy';
import { Section } from './bits';
type Send = (command: Command) => Promise<Reply | undefined>;

export function SearchSettings({ state, send }: { state: PanelState; send: Send }) {
  const current = state.settings.search;
  const [providerId, setProviderId] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const selected = BUILTIN_SEARCH_PROVIDERS.find((provider) => provider.id === providerId);

  const run = async (command: Command) => {
    setBusy(true);
    try { return await send(command); } finally { setBusy(false); }
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
    if (reply?.ok) {
      setCredentials({});
      await run({ type: 'testSearch', providerId: selected.id });
    }
  };

  const pick = (id: string) => {
    setProviderId(id);
    setCredentials({});
    setHint(null);
  };

  return (
    <Section title="联网搜索">
      <AgentPreferences state={state} send={send} />
      {outboundReceiverLines(state.settings).map(line => <p className="hint" key={line}>{line}</p>)}
      {current.providerName && (
        <p className="status-banner">已配置 {current.providerName}。换一家先点下面一张卡。</p>
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
      {current.providerName && (
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

function AgentPreferences({ state, send }: { state: PanelState; send: Send }) {
  const saved = state.settings.search.agent;
  const [draft, setDraft] = useState(saved.policy);
  const [synced, setSynced] = useState(saved.policy);
  const [busy, setBusy] = useState(false);
  if (synced !== saved.policy) {
    setSynced(saved.policy);
    if (draft === synced) setDraft(saved.policy);
  }
  const save = async (patch: Partial<AgentSettings>) => {
    setBusy(true);
    try { return await send({ type: 'saveSearchAgentSettings', patch }); } finally { setBusy(false); }
  };
  return <div className="set-card">
    <label><input type="checkbox" aria-label="智能联网" checked={saved.enabled} disabled={busy}
      onChange={event => void save({ enabled: event.target.checked })} />智能联网（分层触发）</label>
    <p className="hint">默认关闭。开启后按问题判断是否搜索；关闭会停止当前研究。</p>
    <label>新鲜度<select aria-label="新鲜度" value={saved.freshness} disabled={busy} onChange={event => void save({ freshness: event.target.value as AgentSettings['freshness'] })}>
      {[['auto', '自动'], ['live', '实时'], ['day', '一天内'], ['week', '一周内'], ['month', '一月内'], ['any', '不限时间']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <label>搜索深度<select aria-label="搜索深度" value={saved.depth} disabled={busy} onChange={event => void save({ depth: event.target.value as AgentSettings['depth'] })}>
      <option value="deep">深入核对</option><option value="quick">快速核对</option>
    </select></label>
    <PreferenceText label="搜索语言" saved={saved.language} placeholder="跟随浏览器，如 zh-CN" save={value => save({ language: value })} />
    <PreferenceText label="搜索地区" saved={saved.region} placeholder="跟随浏览器，如 CN；浏览器未指定则不限" save={value => save({ region: value })} />
    <PreferenceText label="偏好域名" saved={saved.preferredDomains.join(', ')} placeholder="最多 5 个，用逗号分隔" save={value => save({ preferredDomains: value.split(/[,，\s]+/).filter(Boolean) })} />
    <label>来源读取<select aria-label="来源读取" value={saved.sourceReading} disabled={busy} onChange={event => void save({ sourceReading: event.target.value as AgentSettings['sourceReading'] })}>
      <option value="provider">供应商内容接口（不可用时使用摘要）</option><option value="off">只使用搜索摘要</option>
      <option value="direct_allowed" disabled={!state.settings.search.sourceCapabilities.directRead}>授权后直接读取来源网站</option>
    </select></label>
    <p className="hint">{state.settings.search.sourceCapabilities.directReadReason}</p>
    <label htmlFor="search-policy">联网 Agent 策略</label>
    <textarea id="search-policy" rows={15} maxLength={8000} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
    <p className="hint">策略版本 {SEARCH_AGENT_VERSION}。修改新鲜度、深度和策略只影响下一次提问；工具、权限、接收方和输出规则由程序固定。</p>
    <div className="composer-actions">
      <button disabled={busy || !draft.trim()} onClick={() => void save({ policy: draft })}>保存联网策略</button>
      <button disabled={busy} onClick={() => { setDraft(DEFAULT_SEARCH_AGENT_POLICY); void save({ policy: '' }); }}>恢复默认联网策略</button>
    </div>
  </div>;
}

function PreferenceText({ label, saved, placeholder, save }: { label: string; saved: string; placeholder: string; save: (value: string) => Promise<Reply | undefined> }) {
  const [draft, setDraft] = useState(saved);
  const [synced, setSynced] = useState(saved);
  if (synced !== saved) { setSynced(saved); if (draft === synced) setDraft(saved); }
  return <label>{label}<input aria-label={label} value={draft} placeholder={placeholder} onChange={event => setDraft(event.target.value)} onBlur={() => { if (draft !== saved) void save(draft); }} /></label>;
}
