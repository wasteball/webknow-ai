import { useState } from 'react';

import type { Command, PanelState, Reply } from '../../core/protocol';
import { Section } from './bits';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 设置只做三件事：钥匙管理、教学提问方式的覆盖与恢复、内容清理。
 * 清除这一页、清除全部、删掉钥匙、恢复默认提问方式，是四个互不牵连的操作（FR-033）。
 */
export function Settings({ state, send }: { state: PanelState; send: Send }) {
  const [key, setKey] = useState('');
  const [prompt, setPrompt] = useState(state.teachingPrompt);
  const [busy, setBusy] = useState(false);

  const run = async (command: Command) => {
    setBusy(true);
    await send(command);
    setBusy(false);
  };

  return (
    <>
      <Section title="DeepSeek 钥匙">
        <p className="hint">{state.hasKey ? '已经保存了一把钥匙。' : '还没有填钥匙。'}</p>
        <label htmlFor="replace-key">换一把新钥匙</label>
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
        <p className="hint">删掉钥匙不会清掉你读过的内容，也不会把下面的提问方式恢复默认。</p>
      </Section>

      <Section title="“AI 问我”用什么方式提问">
        <p className="hint">
          只有这一项可以改。摘要、话题建议和普通问答由我们维护，没有开放修改。
          你写的内容只在“AI 问我”里生效，也改不了费用上限、权限或内容的去向。
        </p>
        <label htmlFor="teaching-prompt">你希望它怎么问你</label>
        <textarea
          id="teaching-prompt"
          rows={8}
          maxLength={8000}
          value={prompt}
          placeholder="留空就用我们默认的提问方式。"
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="composer-actions">
          <button
            type="button"
            disabled={busy || !prompt.trim()}
            onClick={() => void run({ type: 'saveTeachingPrompt', text: prompt })}
          >
            保存
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setPrompt('');
              void run({ type: 'resetTeachingPrompt' });
            }}
          >
            恢复默认
          </button>
        </div>
        <p className="hint">
          保存后从下一次“AI 问我”开始生效，正在进行的那一轮不受影响。
          {state.teachingPromptIsCustom ? '当前用的是你写的版本。' : '当前用的是默认版本。'}
        </p>
      </Section>

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
        <p className="hint">这两个操作都不会删掉钥匙，也不会恢复默认提问方式。</p>
      </Section>
    </>
  );
}
