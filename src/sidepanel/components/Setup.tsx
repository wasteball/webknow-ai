import { useState } from 'react';

import type { Command, PanelState, Reply } from '../../core/protocol';
import { Section } from './bits';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 首次配置。读者是普通用户，不是工程师：不使用 API、供应商、密钥、令牌这类词，
 * 但仍然完整说清“谁收费、收什么、发给谁”（FR-019/FR-020/FR-022）。
 */
export function Setup({ state, send }: { state: PanelState; send: Send }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const reply = await send({ type: 'saveKey', key });
    setBusy(false);
    if (reply?.ok) setKey('');
  };

  return (
    <Section title="这把钥匙怎么弄到">
      <p>
        这个插件自己不提供 AI，它是借你自己的 DeepSeek 账号来帮你读网页。所以要先用你的账号换一把“钥匙”，
        插件才能替你向 DeepSeek 提问。
      </p>
      <p>
        费用由 DeepSeek 按你用掉多少收，从你自己的账号里扣。我们不收钱，也看不到你的钥匙。
      </p>
      <ol className="steps">
        <li>
          打开
          <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
            DeepSeek 的钥匙页面
          </a>
          （会新开一个标签页）。
        </li>
        <li>用手机号或邮箱登录。没有账号就先注册，并按页面提示充值一点金额。</li>
        <li>点“创建 API key”，会出现一串以 sk- 开头的字符。复制它。</li>
        <li>回到这里粘到下面，点保存。</li>
      </ol>
      <p className="hint">
        保存时会先试连一次，确认这把钥匙能用。试连不会发送你正在看的网页，但会有极少量费用。
      </p>
      <label htmlFor="deepseek-key">把以 sk- 开头的那串字符粘贴到这里</label>
      <input
        id="deepseek-key"
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
