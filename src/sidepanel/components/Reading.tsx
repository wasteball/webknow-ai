import { useEffect, useState, type KeyboardEvent } from 'react';

import type { ChatTurn } from '../../core/session';
import type { PanelState, Reply } from '../../core/protocol';
import type { Command } from '../../core/protocol';
import { shouldSubmitComposer } from '../composer';
import { visibleSuggestions } from '../suggest';
import { Busy, ComposerField, ComposerTextarea, Drafting, SourceTag, SuggestRow, Thinking } from './bits';
import { Icon } from './Icon';
import { Rich } from './Rich';
import { Conversation } from './Conversation';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 「问 AI」：摘要与话题在最上面，点一张卡片就是发出去一句；
 * 下面自己接着问。输入区吸在底部。
 *
 * 回答正文走 <Rich>：模型写的是受控 markdown 子集，这里是它唯一的渲染入口。
 */
export function Reading({ state, send, onSearchSettings, active = true }: { state: PanelState; send: Send; onSearchSettings?: () => void; active?: boolean }) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [followRequest, setFollowRequest] = useState(0);
  const [searchOn, setSearchOn] = useState(false);
  const [hidingSuggests, setHidingSuggests] = useState(false);
  const [hiddenAtTurns, setHiddenAtTurns] = useState(0);
  const [pending, setPending] = useState<{ question: string; quoteText: string | null; at: number } | null>(null);
  const tabId = state.tabId;
  const progress = state.busy?.kind === 'answer' ? state.busy : null;
  const busy = Boolean(progress) || submitting;
  const blocked = state.busy !== null && state.busy.kind !== 'answer';
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

  const [consumedQuote, setConsumedQuote] = useState<string | null>(null);
  const quoteKey = state.quote?.id ?? state.quote?.text ?? null;
  const quote = quoteKey !== consumedQuote ? state.quote : null;
  const outgoing = pending && pending.at === state.chat.length ? pending : null;

  const updateKey = `${state.chat.length}:${busy}:${progress?.draft.length ?? 0}:${progress?.reasoning.length ?? 0}:${outgoing?.question ?? ''}:${row.next.length}`;

  useEffect(() => {
    setHidingSuggests(false);
  }, [state.chat.length]);

  const concealSuggests = () => {
    setHiddenAtTurns(state.chat.length);
    setHidingSuggests(true);
  };
  const stop = () => {
    if (tabId) void send({ type: 'stop', tabId });
  };
  const sendQuestion = async (question: string) => {
    if (!tabId || !question.trim() || busy || blocked) return;
    const text = question.trim();
    concealSuggests();
    setPending({ question: text, quoteText: quote?.text ?? null, at: state.chat.length });
    setConsumedQuote(quoteKey);
    setDraft((current) => (current.trim() === text ? '' : current));
    setSubmitting(true);
    setFollowRequest((n) => n + 1);
    const reply = await send({ type: 'ask', tabId, question: text, search: searchEnabled && searchOn, quote: quote?.text ?? null, ...(quote?.id ? { quoteId: quote.id } : {}) }).finally(() => setSubmitting(false));
    if (reply?.ok) return;
    setConsumedQuote((current) => current === quoteKey ? null : current);
    setPending((current) => (current?.question === text ? null : current));
    setHidingSuggests(false);
    setDraft((current) => (current.trim() ? current : text));
  };
  const ask = (question: string) => void sendQuestion(question);

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) {
      return;
    }
    event.preventDefault();
    if (!busy && !blocked) void ask(draft);
  };

  const sendTopic = async (bubbleId: string, question: string) => {
    if (!tabId || busy || blocked) return;
    concealSuggests();
    setPending({ question, quoteText: null, at: state.chat.length });
    setSubmitting(true);
    setFollowRequest((n) => n + 1);
    const reply = await send({ type: 'explore', tabId, bubbleId }).finally(() => setSubmitting(false));
    if (reply?.ok) return;
    setPending((current) => (current?.question === question ? null : current));
    setHidingSuggests(false);
  };

  const sendFollowUp = (question: string) => void sendQuestion(question);

  return (
    <>
      <Conversation active={active} updateKey={updateKey} followRequest={followRequest}>
        {guide && (
          <article className="msg ai">
            <Thinking text={guide.reasoning ?? ''} />
            <div className="said said-guide">
              <Rich text={guide.summary} diagrams={false} />
              <SuggestRow
                lead="想接着弄懂哪一点"
                items={row.openers}
                disabled={busy || blocked}
                onPick={(item) => void sendTopic(item.id, item.question)}
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
            disabled={busy || blocked}
            onPick={(item) =>
              row.nextFrom === 'opener' ? void sendTopic(item.id, item.question) : void sendFollowUp(item.question)
            }
          />
        )}
        {outgoing && (
          <article className="msg user">
            <div className="bubble user">
              {outgoing.quoteText && <p className="quote-in-bubble">{outgoing.quoteText}</p>}
              {outgoing.question}
            </div>
          </article>
        )}
        {busy &&
          (state.busy?.draft || state.busy?.reasoning ? (
            <Drafting text={state.busy?.draft ?? ''} reasoning={state.busy?.reasoning ?? ''} />
          ) : (
            <Busy label="正在回答" chars={state.busy?.chars ?? 0} />
          ))}
      </Conversation>

      <div className="dock">
        {blocked && <p className="composer-notice" role="status">AI 问正在生成，结束后可以继续提问。</p>}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && !blocked) void ask(draft);
          }}
        >
          <label className="sr-only" htmlFor="question">
            向这篇文章提问
          </label>
          <ComposerField
            busy={busy}
            idleLabel="发送"
            onStop={stop}
            submitDisabled={blocked || !draft.trim()}
            context={quote && (
              <div className="quote-chip">
                <div className="quote-chip-head">
                  <span className="quote-chip-label"><Icon name="file" small />引用内容</span>
                  <button
                    type="button"
                    className="quote-remove"
                    aria-label="不用这段"
                    title="移除引用"
                    onClick={() => {
                      if (tabId === null) return;
                      setConsumedQuote(quoteKey);
                      void send({ type: 'clearQuote', tabId, quoteId: quote.id }).then((reply) => {
                        if (!reply?.ok) setConsumedQuote((current) => current === quoteKey ? null : current);
                      });
                    }}
                  >
                    <Icon name="x" small />
                  </button>
                </div>
                <blockquote>
                  <button
                    type="button"
                    className="quote-text"
                    disabled={!quote.blockId || !tabId}
                    title={quote.blockId ? '回到页面位置' : undefined}
                    onClick={() => quote.blockId && tabId && void send({ type: 'jump', tabId, blockId: quote.blockId })}
                  >
                    {quote.text}
                  </button>
                </blockquote>
              </div>
            )}
            tools={(searchEnabled || onSearchSettings) && (
              <button
                type="button"
                className="search-chip"
                aria-pressed={searchEnabled && searchOn}
                title={searchEnabled
                  ? `打开后，只把搜索词发给${state.settings.search.providerName ?? '搜索服务'}，不发这一页正文`
                  : '先选择一个联网搜索服务'}
                onClick={() => searchEnabled ? setSearchOn((current) => !current) : onSearchSettings?.()}
              >
                <Icon name="globe" small />
                联网搜索
                {searchEnabled && searchOn && <Icon name="check" small />}
              </button>
            )}
          >
            <ComposerTextarea
              id="question"
              value={draft}
              rows={2}
              maxLength={500}
              placeholder={quote ? '针对这段，你想问什么？' : '有什么不懂的？'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
            />
          </ComposerField>
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
            <details className="citations">
              <summary>查看依据</summary>
              {turn.citations.map((citation, index) => (
                <button
                  key={citation.blockId}
                  type="button"
                  className="link"
                  aria-label={`回到文中 ${index + 1}`}
                  onClick={() => tabId && void send({ type: 'jump', tabId, blockId: citation.blockId })}
                >
                  位置 {index + 1}
                </button>
              ))}
            </details>
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
