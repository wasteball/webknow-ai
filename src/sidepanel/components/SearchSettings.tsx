import { useState } from 'react';
import { browser } from 'wxt/browser';
import type { Command, PanelState, Reply } from '../../core/protocol';
import { BUILTIN_SEARCH_PROVIDERS } from '../../core/search/registry';
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
      <p className="hint">选好工具后，在文章输入框打开「联网搜索」。何时搜索、怎样查证由产品处理；旧版研究偏好和自定义联网策略不再生效。</p>
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
