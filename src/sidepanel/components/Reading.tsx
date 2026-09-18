import { useEffect, useRef, useState } from 'react';

import type { ChatTurn } from '../../core/session';
import type { PanelState, Reply } from '../../core/protocol';
import type { Command } from '../../core/protocol';
import { Busy, Section, SourceTag } from './bits';

type Send = (command: Command) => Promise<Reply | undefined>;

export function Reading({ state, send }: { state: PanelState; send: Send }) {
  const [draft, setDraft] = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const tabId = state.tabId;
  const endRef = useRef<HTMLDivElement>(null);
  const busy = state.busy?.kind === 'answer';
  const searchEnabled = state.settings.search.enabled;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [state.chat.length, busy]);

  const ask = async (question: string) => {
    if (!tabId || !question.trim()) return;
    const reply = await send({ type: 'ask', tabId, question, search: searchEnabled && searchOn });
    if (reply?.ok) setDraft('');
  };

  return (
    <>
      <Section title="问答">
        {state.chat.length === 0 && !busy && (
          <p className="hint">可以点上面的话题，也可以自己在下面提问。</p>
        )}
        {state.chat.map((turn) => (
          <Turn key={turn.id} turn={turn} tabId={tabId} send={send} />
        ))}
        {busy && (
          <Busy
            label="正在回答"
            chars={state.busy?.chars ?? 0}
            onStop={() => tabId && void send({ type: 'stop', tabId })}
          />
        )}
        <div ref={endRef} />
      </Section>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <label className="sr-only" htmlFor="question">
          向这篇文章提问
        </label>
        <textarea
          id="question"
          value={draft}
          rows={2}
          maxLength={500}
          placeholder="想问什么，写在这里…"
          onChange={(event) => setDraft(event.target.value)}
        />
        {searchEnabled && (
          <label className="search-toggle">
            <input
              type="checkbox"
              checked={searchOn}
              onChange={(event) => setSearchOn(event.target.checked)}
            />
            <span>联网搜索（只把搜索词发给{state.settings.search.providerName ?? '搜索服务'}）</span>
          </label>
        )}
        <div className="composer-actions">
          <button type="submit" disabled={busy || !draft.trim()}>
            发送
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || state.phase !== 'READY'}
            onClick={() => {
              const goal = draft.trim();
              setDraft('');
              if (tabId) void send({ type: 'learnStart', tabId, goal });
            }}
          >
            让 AI 问我
          </button>
        </div>
      </form>
    </>
  );
}

function Turn({ turn, tabId, send }: { turn: ChatTurn; tabId: number | null; send: Send }) {
  return (
    <article className="turn">
      <p className="question">{turn.question}</p>
      <p className="answer">
        <SourceTag source={turn.source} />
        <span className="answer-text">{turn.answer}</span>
      </p>
      {turn.citations.length > 0 && (
        <p className="citations">
          {turn.citations.map((citation, index) => (
            <button
              key={citation.blockId}
              type="button"
              className="link"
              onClick={() => tabId && void send({ type: 'jump', tabId, blockId: citation.blockId })}
            >
              看看原文{index + 1}
            </button>
          ))}
        </p>
      )}
      {turn.references.length > 0 && (
        <p className="citations">
          网络资料：
          {turn.references.map((url, index) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="link">
              链接{index + 1}{' '}
            </a>
          ))}
        </p>
      )}
      {turn.unanswered.length > 0 && (
        <ul className="unanswered">
          {turn.unanswered.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </article>
  );
}
