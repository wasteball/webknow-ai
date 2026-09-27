import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { ChatTurn } from '../../core/session';
import type { PanelState, Reply } from '../../core/protocol';
import type { Command } from '../../core/protocol';
import { shouldSubmitComposer } from '../composer';
import { visibleSuggestions } from '../suggest';
import { Busy, ComposerField, Drafting, SourceTag, SuggestRow, Thinking } from './bits';
import { Icon } from './Icon';
import { Rich } from './Rich';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 「问 AI」：摘要与话题在最上面，点一张卡片就是发出去一句；
 * 下面自己接着问。输入区吸在底部。
 *
 * 回答正文走 <Rich>：模型写的是受控 markdown 子集，这里是它唯一的渲染入口。
 */
export function Reading({ state, send }: { state: PanelState; send: Send }) {
  const [draft, setDraft] = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const [hidingSuggests, setHidingSuggests] = useState(false);
  const [hiddenAtTurns, setHiddenAtTurns] = useState(0);
  const tabId = state.tabId;
  const endRef = useRef<HTMLDivElement>(null);
  const busy = state.busy?.kind === 'answer';
  const searchEnabled = state.settings.search.enabled;
  const diagrams = state.settings.diagrams === 'auto';
  const guide = state.guide;
  const lastTurn = state.chat[state.chat.length - 1];
  const row = visibleSuggestions({
    chatLength: state.chat.length,
    busy,
    hiding: hidingSuggests,
    hiddenAtTurns,
    openers: guide?.bubbles ?? [],
    followUps: lastTurn?.followUps ?? [],
    askedQuestions: state.chat.map((turn) => turn.question),
  });

  // 只在对话真的往下走时跟到底部。挂载时不滚：这一栏开头是摘要与话题，
  // 一进来就被推到最后一轮问答上，等于把最重要的内容藏起来了。
  const seen = useRef<{ turns: number; busy: boolean; next: number } | null>(null);
  useEffect(() => {
    const next = row.next.length;
    if (!seen.current) {
      seen.current = { turns: state.chat.length, busy, next };
      return;
    }
    if (state.chat.length > seen.current.turns || (busy && !seen.current.busy) || next > seen.current.next) {
      endRef.current?.scrollIntoView({ block: 'end' });
    }
    seen.current = { turns: state.chat.length, busy, next };
  }, [state.chat.length, busy, row.next.length]);

  useEffect(() => {
    setHidingSuggests(false);
  }, [state.chat.length]);

  const quote = state.quote;
  const concealSuggests = () => {
    setHiddenAtTurns(state.chat.length);
    setHidingSuggests(true);
  };
  const stop = () => {
    if (tabId) void send({ type: 'stop', tabId });
  };
  const ask = async (question: string) => {
    if (!tabId || !question.trim()) return;
    concealSuggests();
    const reply = await send({ type: 'ask', tabId, question, search: searchEnabled && searchOn });
    if (reply?.ok) setDraft('');
    else setHidingSuggests(false);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) {
      return;
    }
    event.preventDefault();
    if (!busy) void ask(draft);
  };

  const sendTopic = async (bubbleId: string) => {
    if (!tabId) return;
    concealSuggests();
    const reply = await send({ type: 'explore', tabId, bubbleId });
    if (!reply?.ok) setHidingSuggests(false);
  };

  const sendFollowUp = async (question: string) => {
    if (!tabId) return;
    concealSuggests();
    const reply = await send({ type: 'ask', tabId, question, search: searchEnabled && searchOn });
    if (!reply?.ok) setHidingSuggests(false);
  };

  return (
    <>
      <div className="chat">
        {guide && (
          <article className="msg ai">
            <Thinking text={guide.reasoning ?? ''} />
            <div className="said said-guide">
              <Rich text={guide.summary} diagrams={false} />
              <SuggestRow
                lead="想接着弄懂哪一点"
                items={row.openers}
                disabled={busy}
                onPick={(item) => void sendTopic(item.id)}
              />
            </div>
          </article>
        )}

        {state.chat.map((turn) => (
          <Turn key={turn.id} turn={turn} tabId={tabId} send={send} diagrams={diagrams} />
        ))}
        {row.next.length > 0 && (
          <SuggestRow
            lead="可以接着问"
            items={row.next}
            disabled={busy}
            onPick={(item) =>
              row.nextFrom === 'opener' ? void sendTopic(item.id) : void sendFollowUp(item.question)
            }
          />
        )}
        {busy &&
          (state.busy?.draft || state.busy?.reasoning ? (
            <Drafting text={state.busy?.draft ?? ''} reasoning={state.busy?.reasoning ?? ''} />
          ) : (
            <Busy label="正在回答" chars={state.busy?.chars ?? 0} />
          ))}
        <div className="chat-end" ref={endRef} />
      </div>

      <div className="dock">
        {quote && (
          <div className="quote-chip">
            <blockquote>
              <button
                type="button"
                className="quote-text"
                disabled={!quote.blockId || !tabId}
                onClick={() => quote.blockId && tabId && void send({ type: 'jump', tabId, blockId: quote.blockId })}
              >
                {quote.text}
              </button>
            </blockquote>
            <button
              type="button"
              className="quiet"
              onClick={() => tabId && void send({ type: 'clearQuote', tabId })}
            >
              不用这段
            </button>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void ask(draft);
          }}
        >
          <label className="sr-only" htmlFor="question">
            向这篇文章提问
          </label>
          <ComposerField busy={busy} idleLabel="发送" onStop={stop}>
            <textarea
              id="question"
              value={draft}
              rows={2}
              maxLength={500}
              placeholder={quote ? '针对这段，你想问什么？' : '有什么不懂的？'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
            />
          </ComposerField>
          {searchEnabled && (
            <div className="composer-actions">
              <button
                type="button"
                className="search-chip"
                aria-pressed={searchOn}
                title={`打开后，只把搜索词发给${state.settings.search.providerName ?? '搜索服务'}，不发这一页正文`}
                onClick={() => setSearchOn((current) => !current)}
              >
                联网搜索
              </button>
            </div>
          )}
        </form>
      </div>
    </>
  );
}

/** 一轮问答 = 你的气泡（右） + AI 的正文（左，无气泡）。 */
function Turn({
  turn,
  tabId,
  send,
  diagrams,
}: {
  turn: ChatTurn;
  tabId: number | null;
  send: Send;
  diagrams: boolean;
}) {
  return (
    <>
      <article className="msg user">
        <div className="bubble user">
          {turn.quote && <p className="quote-in-bubble">{turn.quote.text}</p>}
          {turn.question}
        </div>
      </article>
      <article className="msg ai">
        <Thinking text={turn.reasoning ?? ''} />
        <div className="said">
          <SourceTag source={turn.source} />
          <Rich text={turn.answer} diagrams={diagrams} />
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
                  链接{index + 1}
                  <Icon name="external" small />
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
        </div>
      </article>
    </>
  );
}
