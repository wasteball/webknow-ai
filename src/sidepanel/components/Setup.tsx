import { useState } from 'react';

import type { Command, PanelState, Reply } from '../../core/protocol';
import { Section } from './bits';

type Send = (command: Command) => Promise<Reply | undefined>;

/** 首次配置：只提供 DeepSeek Key，不提供供应商、Base URL、模型名或采样参数（FR-019）。 */
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
    <Section title="配置 DeepSeek Key">
      <p>
        webknow-ai 使用你自己的 DeepSeek API Key。调用费用由你的 DeepSeek 账号承担，
        本产品不代付、不中转，也不提供其他模型供应商。
      </p>
      <ol className="steps">
        <li>
          到
          <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
            DeepSeek 开放平台
          </a>
          创建一个 API Key。
        </li>
        <li>粘贴到下面并保存。保存前会执行一次固定的最小连接测试。</li>
      </ol>
      <p className="hint">
        连接测试不会发送网页正文，但可能产生少量费用。Key 只保存在本扩展的本地存储中，
        不参与浏览器同步，也不会进入页面脚本、提示词、对话、日志或诊断数据。
      </p>
      <label htmlFor="deepseek-key">DeepSeek API Key</label>
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
          {busy ? '正在测试连接…' : '保存并测试连接'}
        </button>
      </div>
      {state.hasKey && <p className="hint">当前已保存 Key。可以在设置里替换或删除。</p>}
    </Section>
  );
}
