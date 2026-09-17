import { useEffect, useRef, useState } from 'react';

import type { ChatTurn } from '../../core/session';
import type { PanelState, Reply } from '../../core/protocol';
import type { Command } from '../../core/protocol';
import { Busy, Section, SourceTag } from './bits';

type Send = (command: Command) => Promise<Reply | undefined>;

export function Reading({ state, send }: { state: PanelState; send: Send }) {
  const [draft, setDraft] = useState('');
  const tabId = state.tabId;
  const endRef = useRef<HTMLDivElement>(null);
  const busy = state.busy?.kind === 'answer';

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [state.chat.length, busy]);

  const ask = async (question: string) => {
    if (!tabId || !question.trim()) return;
    const reply = await send({ type: 'ask', tabId, question });
    if (reply?.ok) setDraft('');
  };

  return (
    <>
      {state.guide && (
        <Section title="这篇文章讲了什么">
          <p className="summary">{state.guide.summary}</p>
          {state.guide.bubbles.length > 0 && (
            <div className="bubbles">
              {state.guide.bubbles.map((bubble) => (
                <button
                  key={bubble.id}
                  type="button"
                  className="bubble"
                  disabled={busy}
                  onClick={() => {
                    if (tabId) void send({ type: 'explore', tabId, bubbleId: bubble.id });
                  }}
                >
                  {bubble.question}
                </button>
              ))}
            </div>
          )}
        </Section>
      )}

      <Section title="问答">
        {state.chat.length === 0 && !busy && (
          <p className="hint">可以直接提问，也可以点上面的探索方向。</p>
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
          placeholder="针对这篇文章提问…"
          onChange={(event) => setDraft(event.target.value)}
        />
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
            AI 问我
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
              回到原文{index + 1}
            </button>
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
