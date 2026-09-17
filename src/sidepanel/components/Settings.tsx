import { useState } from 'react';

import type { Command, PanelState, Reply } from '../../core/protocol';
import { Section } from './bits';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 高级设置只做三件事：Key 管理、教学提示词覆盖与恢复、数据清理。
 * 清除会话、清除全部会话、删除 Key、恢复默认教学提示词是四个独立操作（FR-033）。
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
      <Section title="DeepSeek Key">
        <p className="hint">{state.hasKey ? '已保存 Key。' : '尚未保存 Key。'}</p>
        <label htmlFor="replace-key">替换为新的 Key</label>
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
            保存并测试
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !key.trim()}
            onClick={() => void run({ type: 'testKey', key })}
          >
            只测试连接
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy || !state.hasKey}
            onClick={() => void run({ type: 'deleteKey' })}
          >
            删除 Key
          </button>
        </div>
        <p className="hint">删除 Key 不会清除会话内容，也不会恢复教学提示词。</p>
      </Section>

      <Section title="“AI 问我”教学提示词">
        <p className="hint">
          只有教学提示词可以覆盖；摘要、探索气泡和自由问答的策略由维护者维护，没有编辑入口。
          覆盖只影响之后新开始的学习会话，无法改变输出格式、预算、权限或数据接收方。
        </p>
        <label htmlFor="teaching-prompt">自定义教学提示词</label>
        <textarea
          id="teaching-prompt"
          rows={8}
          maxLength={8000}
          value={prompt}
          placeholder="留空表示使用内置默认教学策略。"
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="composer-actions">
          <button
            type="button"
            disabled={busy || !prompt.trim()}
            onClick={() => void run({ type: 'saveTeachingPrompt', text: prompt })}
          >
            保存教学提示词
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
        {state.teachingPromptIsCustom && <p className="hint">当前使用的是你的自定义版本。</p>}
      </Section>

      <Section title="数据">
        <p className="hint">
          正文、摘要、气泡、对话与学习状态只保留在当前浏览会话：关闭标签页会清除该标签页的数据，
          关闭浏览器会清除全部会话数据。
        </p>
        <div className="composer-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy || state.tabId === null}
            onClick={() => state.tabId !== null && void run({ type: 'clearSession', tabId: state.tabId })}
          >
            清除当前页会话
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void run({ type: 'clearAllSessions' })}
          >
            清除全部会话
          </button>
        </div>
        <p className="hint">以上操作都不会删除 Key 或教学提示词。</p>
      </Section>
    </>
  );
}
