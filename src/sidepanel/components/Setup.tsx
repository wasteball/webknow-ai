import { useState } from 'react';

import { findProvider } from '../../core/model-providers';
import type { Command, PanelState, Reply } from '../../core/protocol';
import { Section } from './bits';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 首次配置。读者是普通用户，不是工程师：不使用 API、供应商、密钥、令牌这类词，
 * 但仍然完整说清“谁收费、收什么、发给谁”（FR-019/FR-020/FR-022）。
 *
 * 文案跟着当前模型供应商走：换一家时"去哪拿钥匙、钥匙长什么样、发给谁"三件事
 * 都要跟着变，否则用户会拿着 DeepSeek 的说明去智谱找 sk- 开头的串。
 */
export function Setup({ state, send }: { state: PanelState; send: Send }) {
  const provider = findProvider(state.settings.provider);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const reply = await send({ type: 'saveKey', provider: provider.id, key });
    setBusy(false);
    if (reply?.ok) setKey('');
  };

  return (
    <Section title="这把钥匙怎么弄到">
      <p>
        这个插件自己不提供 AI，它是借你自己的 {provider.name} 账号来帮你读网页。所以要先用你的账号换一把“钥匙”，
        插件才能替你向 {provider.name} 提问。
      </p>
      <p>
        费用由 {provider.name} 按你用掉多少收，从你自己的账号里扣。我们不收钱，也看不到你的钥匙。
      </p>
      <ol className="steps">
        <li>
          打开
          <a href={provider.keyPage} target="_blank" rel="noreferrer">
            {provider.name} 的钥匙页面
          </a>
          （会新开一个标签页）。
        </li>
        <li>用手机号或邮箱登录。没有账号就先注册，并按页面提示充值一点金额。</li>
        <li>创建一个 API key，会出现一串字符（{provider.keyHint}）。复制它。</li>
        <li>回到这里粘到下面，点保存。</li>
      </ol>
      <p className="hint">
        保存时会先试连一次，确认这把钥匙能用。试连不会发送你正在看的网页，但会有极少量费用。
        想换一家？保存完钥匙后到设置 → 模型里切换。
      </p>
      <label htmlFor="provider-key">把 {provider.name} 的那串字符粘贴到这里</label>
      <input
        id="provider-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <div className="composer-actions">
        <button type="button" disabled={busy || !key.trim()} onClick={() => void save()}>
          {busy ? '正在确认这把钥匙…' : '保存并确认能用'}
        </button>
      </div>
      {state.hasKey && <p className="hint">已经保存过一把钥匙了。想换可以到设置里替换。</p>}
    </Section>
  );
}
