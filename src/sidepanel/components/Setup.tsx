import { useState } from 'react';
import { browser } from 'wxt/browser';

import { findProvider, MODEL_PROVIDERS, type ProviderId } from '../../core/model-providers';
import type { Command, PanelState, Reply } from '../../core/protocol';
import { outboundFeeLine, outboundReceiverLines } from '../outbound-copy';
import { BrandMark, Icon } from './Icon';

type Send = (command: Command) => Promise<Reply | undefined>;

const PITCH: Record<ProviderId, string> = {
  deepseek: '中文理解好，还能看懂网页里的部分图片',
  zhipu: '国内老牌，回答稳',
};

/**
 * 第一次用：三步，每步一屏，可以返回。
 * 1. 选一家 AI；2. 拿钥匙并粘贴，粘贴后自动检查（保存钥匙命令本来就会先测一次连接，不发网页）；
 * 3. 读这一页试试——仍走正常的外发确认与读取，不绕过任何一步。
 */
export function Setup({ state, send, canRead, onRead, onDone }: {
  state: PanelState;
  /** 不弹全局提示的发送：结果就地显示在这一步里。 */
  send: Send;
  canRead: boolean;
  onRead: () => void;
  onDone: () => void;
}) {
  const { settings } = state;
  const [step, setStep] = useState<1 | 2 | 3>(state.hasKey ? 3 : 1);
  const [selected, setSelected] = useState<ProviderId>(settings.provider);
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const provider = findProvider(selected);

  /** 智谱的访问权限要在点击里第一个申请；放在“下一步”这一下里，粘贴时就不用再弹窗。 */
  const next = async () => {
    if (!provider.fixedHost) {
      let granted = false;
      try { granted = await browser.permissions.request({ origins: [provider.origin] }); } catch { granted = false; }
      if (!granted) {
        setResult({ ok: false, text: `没有获得访问 ${provider.name} 的许可，再点一次“下一步”并选择允许。` });
        return;
      }
    }
    setResult(null);
    setStep(2);
  };

  const check = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || checking) return;
    setChecking(true);
    setResult(null);
    try {
      const reply = await send({ type: 'saveKey', provider: selected, key: trimmed });
      if (!reply?.ok) {
        setResult({ ok: false, text: reply?.error.message ?? '没检查成功，再试一次。' });
        return;
      }
      if (selected !== settings.provider) await send({ type: 'saveSettings', patch: { provider: selected } });
      setKey('');
      setResult({ ok: true, text: '可以用了' });
    } finally {
      setChecking(false);
    }
  };

  const stepper = (
    <p className="stepper">
      <span>第 {step} 步，共 3 步</span>
      <span className="stepper-bar" aria-hidden="true"><i style={{ width: `${(step / 3) * 100}%` }} /></span>
    </p>
  );

  return (
    <section className="onb" aria-label="第一次使用">
      {step === 1 && (
        <div className="onb-hero">
          <BrandMark size={48} />
          <h1>哪里不懂，划哪里</h1>
          <p className="lead">读网页时随时问我，我也会反过来考考你，帮你真的读懂。</p>
        </div>
      )}
      {stepper}

      {step === 1 && <>
        <h2>选一家 AI 来帮你读</h2>
        <div className="group" role="radiogroup" aria-label="AI 服务">
          {MODEL_PROVIDERS.map((item, index) => (
            <button key={item.id} type="button" role="radio" className="method" aria-checked={selected === item.id}
              onClick={() => { setSelected(item.id); setResult(null); }}>
              <span className="radio" aria-hidden="true" />
              <span className="method-copy">
                <span className="method-name">{item.name}{index === 0 && <span className="method-note">推荐</span>}</span>
                <span className="method-desc">{PITCH[item.id]}</span>
              </span>
            </button>
          ))}
        </div>
        {result && !result.ok && <p className="onb-result bad" role="status">{result.text}</p>}
        <button type="button" className="block" onClick={() => void next()}>下一步</button>
      </>}

      {step === 2 && <>
        <h2>拿一把 {provider.name} 的钥匙</h2>
        <ol className="howto">
          <li>点下面的按钮，打开 {provider.name} 官网并登录</li>
          <li>充一点钱（几块钱能用很久）</li>
          <li>新建一把钥匙，把那串字符复制下来</li>
        </ol>
        <a className="button secondary block" href={provider.keyPage} target="_blank" rel="noreferrer">
          <Icon name="external" small />打开 {provider.name} 官网
        </a>
        <form className="field" onSubmit={(event) => { event.preventDefault(); void check(key); }}>
          <label htmlFor="onb-key">粘贴到这里</label>
          <input id="onb-key" type="password" autoComplete="off" spellCheck={false} value={key}
            placeholder={provider.keyHint} disabled={checking}
            onChange={(event) => { setKey(event.target.value); setResult(null); }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData('text');
              if (pasted.trim()) { event.preventDefault(); setKey(pasted.trim()); void check(pasted); }
            }} />
          {checking && <p className="onb-result" role="status">正在检查这把钥匙…</p>}
          {result && <p className={result.ok ? 'onb-result ok' : 'onb-result bad'} role="status">
            {result.ok && <Icon name="check" small />}{result.text}
          </p>}
          {!result?.ok && <button type="submit" className="secondary" disabled={checking || !key.trim()}>检查</button>}
        </form>
        <button type="button" className="block" disabled={!result?.ok && !settings.providerKeys[selected]} onClick={() => setStep(3)}>下一步</button>
        <button type="button" className="link onb-back" onClick={() => { setResult(null); setStep(1); }}>上一步</button>
      </>}

      {step === 3 && <>
        <h2>好了，试一下</h2>
        {canRead ? <>
          <p className="lead">在你想读的文章页上，点一下就能看到摘要和几个可以接着问的问题。</p>
          {!state.outboundConfirmed && (
            <p className="hint">点了之后，这一页的正文会发给 {findProvider(settings.provider).name} 来理解。{outboundFeeLine(findProvider(settings.provider).name)}</p>
          )}
          <button type="button" className="block" onClick={() => { onDone(); onRead(); }}>
            <Icon name="play" small />{state.outboundConfirmed ? '读这一页试试' : '我确认，读这一页试试'}
          </button>
          <button type="button" className="link onb-back" onClick={onDone}>先不用</button>
        </> : <>
          <p className="lead">打开一篇想读的文章，再点工具栏上的 WebKnow AI 图标，就能开始。</p>
          <button type="button" className="block" onClick={onDone}>知道了</button>
        </>}
      </>}

      <details className="fine">
        <summary>要花钱吗？安全吗？</summary>
        <p>费用由你选的 AI 公司按用量收取，WebKnow AI 不收钱。钥匙只存在你这台电脑上。只有你让我读、或者提问时，网页内容才会发给它。</p>
        <ul>{outboundReceiverLines({ ...settings, provider: selected }).map((line) => <li key={line}>{line}</li>)}</ul>
      </details>
    </section>
  );
}
