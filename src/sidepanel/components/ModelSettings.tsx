import { useEffect, useState } from 'react';

import { MODEL_PROVIDERS } from '../../core/model-providers';
import { thinkingChoices } from '../../core/model-thinking';
import type { Command, PanelState, Reply } from '../../core/protocol';

type Send = (command: Command) => Promise<Reply | undefined>;

/** 查看一家与使用一家是两件事；未连接的服务不会成为当前接收方。 */
export function ModelSettings({ state, send }: { state: PanelState; send: Send }) {
  const { settings } = state;
  const [selected, setSelected] = useState(settings.provider);
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customModel, setCustomModel] = useState('');
  const provider = MODEL_PROVIDERS.find((item) => item.id === selected)!;
  const active = selected === settings.provider;
  const connected = settings.providerKeys[selected];
  const disabled = busy || state.busy !== null;
  const currentName = MODEL_PROVIDERS.find((item) => item.id === settings.provider)!.name;

  useEffect(() => setSelected(settings.provider), [settings.provider]);
  useEffect(() => {
    setKey('');
    setReplacing(false);
    setCustomMode(false);
    setCustomModel('');
    setModels(null);
    setLoadFailed(false);
    if (!connected || !active) return;
    let alive = true;
    void send({ type: 'listModels', provider: selected }).then((reply) => {
      if (!alive) return;
      if (reply?.ok && reply.data?.models?.length) setModels(reply.data.models);
      else setLoadFailed(true);
    });
    return () => { alive = false; };
  }, [selected, connected, active, send]);

  const run = async (command: Command) => {
    setBusy(true);
    try { return await send(command); }
    finally { setBusy(false); }
  };
  const useProvider = () => run({ type: 'saveSettings', patch: { provider: selected } });
  const connect = async () => {
    if (disabled || !key.trim()) return;
    const result = await run({ type: 'saveKey', provider: selected, key: key.trim() });
    if (!result?.ok) return;
    setKey('');
    setReplacing(false);
    if (!active) await useProvider();
  };

  const known = models ?? provider.knownModels;
  const model = settings.models[selected] ?? provider.defaultModel;
  const thinking = thinkingChoices(model);

  return (
    <>
      <header className="page-head">
        <h2>模型</h2>
        <p>选一家，填入自己的钥匙，就可以开始阅读。</p>
      </header>
      <p className="model-current"><span className="model-status-dot" aria-hidden="true" />当前使用 {currentName}</p>
      <div className="model-provider-grid" aria-label="模型服务">
        {MODEL_PROVIDERS.map((item) => {
          const status = item.id === settings.provider && settings.providerKeys[item.id]
            ? '使用中' : settings.providerKeys[item.id] ? '已连接' : '未连接';
          return (
            <button type="button" className="model-provider-card" key={item.id}
              aria-pressed={selected === item.id} disabled={disabled}
              onClick={() => setSelected(item.id)}>
              <span className="model-provider-logo" style={{ background: item.logoColor }} aria-hidden="true">{item.logoChar}</span>
              <span className="model-provider-copy"><strong>{item.name}</strong><span>{status}</span></span>
              {selected === item.id && <span className="model-provider-selected" aria-hidden="true">✓</span>}
            </button>
          );
        })}
      </div>
      <section className="model-connection" aria-label={`${provider.name} 配置`}>
        <div className="model-connection-heading">
          <h3>{provider.name}</h3>
          <span className="hint">{connected ? '钥匙已保存' : '还没有连接'}</span>
        </div>
        {connected && !replacing ? (
          <>
            <p className="key-mask" aria-label={`${provider.name} 的钥匙已保存`}>••••••••••••••••</p>
            <div className="composer-actions">
              {!active && <button type="button" disabled={disabled} onClick={() => void useProvider()}>使用{provider.name}</button>}
              <button type="button" className="secondary" disabled={disabled} onClick={() => setReplacing(true)}>更换钥匙</button>
              <button type="button" className="quiet" disabled={disabled} onClick={() => void run({ type: 'deleteKey', provider: selected })}>删除钥匙</button>
            </div>
          </>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void connect(); }}>
            <label htmlFor={`key-${selected}`} className="model-key-label">{provider.name} 的钥匙</label>
            <input id={`key-${selected}`} type="password" autoComplete="off" spellCheck={false}
              value={key} onChange={(event) => setKey(event.target.value)} placeholder={provider.keyHint} disabled={disabled} />
            <p className="hint">{provider.keyHint}。连接时会试一次，不发送网页，可能产生少量费用。</p>
            <div className="composer-actions">
              <button type="submit" disabled={disabled || !key.trim()}>{busy ? '正在连接…' : active && replacing ? '保存' : '连接并使用'}</button>
              {replacing && <button type="button" className="secondary" disabled={disabled} onClick={() => { setReplacing(false); setKey(''); }}>取消</button>}
            </div>
          </form>
        )}
        <p className="hint model-key-help">还没有钥匙？<a href={provider.keyPage} target="_blank" rel="noreferrer">到 {provider.name} 官网创建</a></p>
        {!active && <p className="hint">只有点击「{connected ? `使用${provider.name}` : '连接并使用'}」才会切换。切换后会再次确认网页内容发给哪家。</p>}
        {state.busy && <p className="hint" role="status">正在生成回答，结束或停止后再更换服务。</p>}
      </section>
      {connected && active && (
        <details className="model-advanced" key={selected}>
          <summary>高级选项</summary>
          <p className="hint">默认模型已经能用。有需要再更换具体模型或思考方式。</p>
          <div className="set-list">
            <div className="set-row">
              <div className="set-row-copy"><p className="set-row-title">用哪个模型</p><p className="set-row-hint">只影响之后的请求。</p></div>
              <div className="set-row-control">
                {customMode ? (
                  <div className="key-field">
                    <input aria-label="用哪个模型" value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder={model} spellCheck={false} />
                    <div className="composer-actions">
                      <button type="button" disabled={disabled || !customModel.trim()} onClick={() => void run({ type: 'saveSettings', patch: { model: customModel.trim() } }).then((reply) => { if (reply?.ok) setCustomMode(false); })}>保存模型</button>
                      <button type="button" className="secondary" disabled={disabled} onClick={() => setCustomMode(false)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <select id="model-select" aria-label="用哪个模型" value={model} disabled={disabled}
                    onChange={(event) => event.target.value === '__custom__' ? setCustomMode(true) : void run({ type: 'saveSettings', patch: { model: event.target.value } })}>
                    {!known.includes(model) && <option value={model}>{model}（当前）</option>}
                    {known.map((item) => <option key={item} value={item}>{item}</option>)}
                    <option value="__custom__">手动填写…</option>
                  </select>
                )}
                {loadFailed && <p className="hint">没能取得完整列表，可使用当前模型或手动填写。</p>}
              </div>
            </div>
            {thinking && settings.thinking && (
              <div className="set-row">
                <div className="set-row-copy"><p className="set-row-title">思考</p><p className="set-row-hint">更深入的思考可能增加等待时间和费用。</p></div>
                <div className="set-row-control"><div className="seg" role="radiogroup" aria-label="思考">
                  {thinking.map((option) => <button type="button" role="radio" key={option.value} aria-checked={settings.thinking === option.value}
                    disabled={disabled} onClick={() => void run({ type: 'saveSettings', patch: { thinking: option.value } })}>{option.label}</button>)}
                </div></div>
              </div>
            )}
          </div>
        </details>
      )}
    </>
  );
}
