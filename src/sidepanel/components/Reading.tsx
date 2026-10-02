import { useEffect, useState, type KeyboardEvent } from 'react';

import type { ChatTurn } from '../../core/session';
import type { Quote } from '../../core/quote';
import type { NetworkMode } from '../../core/search/agent-types';
import { evaluateSearchGate } from '../../core/search/gate';
import type { PanelState, Reply } from '../../core/protocol';
import type { Command } from '../../core/protocol';
import { shouldSubmitComposer } from '../composer';
import { visibleSuggestions } from '../suggest';
import { Busy, ComposerField, ComposerTextarea, Drafting, SourceTag, SuggestRow, Thinking } from './bits';
import { Icon } from './Icon';
import { Rich } from './Rich';
import { Conversation } from './Conversation';
import { SearchProgress } from './SearchProgress';
import { SearchSources } from './SearchSources';
import { ResearchClarification } from './ResearchClarification';

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
  const [network, setNetwork] = useState<NetworkMode>('auto');
  const [hidingSuggests, setHidingSuggests] = useState(false);
  const [hiddenAtTurns, setHiddenAtTurns] = useState(0);
  const [pending, setPending] = useState<{ question: string; quoteText: string | null; at: number } | null>(null);
  const tabId = state.tabId;
  const progress = state.busy?.kind === 'answer' ? state.busy : null;
  const researchPending = state.researchPending;
  const currentPending = state.sessionId && researchPending &&
    (!progress?.agent || (progress.agent.identity.sessionId === state.sessionId && progress.agent.identity.runId === researchPending.runId && progress.agent.identity.tabId === tabId))
    ? researchPending : undefined;
  const researching = Boolean(progress?.agent || currentPending?.status === 'running' || currentPending?.status === 'waiting');
  const busy = Boolean(progress) || submitting || currentPending?.status === 'waiting';
  const blocked = state.busy !== null && state.busy.kind !== 'answer';
  const searchEnabled = state.settings.search.agent.enabled;
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

  const verificationQuestion = draft.trim() || currentPending?.question || outgoing?.question || lastTurn?.question || '';
  const needsVerification = !searchEnabled && Boolean(verificationQuestion) && evaluateSearchGate({
    question: verificationQuestion, pageTitle: state.pageTitle, quote: quote?.text ?? null, mode: network,
    enabled: false, freshness: state.settings.search.agent.freshness, now: new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).level === 'required';

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
  const sendQuestion = async (question: string, sentQuote: Quote | null = quote, retry = false) => {
    if (!tabId || !question.trim() || busy || blocked) return;
    const text = question.trim();
    concealSuggests();
    setPending({ question: text, quoteText: sentQuote?.text ?? null, at: state.chat.length });
    const sentQuoteKey = sentQuote?.id ?? sentQuote?.text ?? null;
    if (!retry || sentQuoteKey === quoteKey) setConsumedQuote(sentQuoteKey);
    if (!retry) setDraft((current) => (current.trim() === text ? '' : current));
    setSubmitting(true);
    setFollowRequest((n) => n + 1);
    const reply = await send({ type: 'ask', tabId, question: text, network, quote: sentQuote?.text ?? null, ...(sentQuote?.id ? { quoteId: sentQuote.id } : {}) }).finally(() => setSubmitting(false));
    if (reply?.ok) return;
    setConsumedQuote((current) => current === sentQuoteKey ? null : current);
    setPending((current) => (current?.question === text ? null : current));
    setHidingSuggests(false);
    if (!retry) setDraft((current) => (current.trim() ? current : text));
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
        {currentPending && state.sessionId && tabId !== null && <ResearchClarification
          key={`${state.sessionId}:${currentPending.runId}:${currentPending.status}`}
          pending={currentPending} tabId={tabId} sessionId={state.sessionId}
          capabilities={state.settings.search.sourceCapabilities} send={send}
          retryDisabled={busy || blocked} onRetry={() => void sendQuestion(currentPending.question, currentPending.quote, true)}
        />}
        {state.researchDetails && researching && <SearchSources references={[]} research={state.researchDetails} />}
        {busy && (researching ? (progress?.agent ? <SearchProgress event={progress.agent} /> : <Busy label="正在判断是否需要联网" chars={0} />) :
          (state.busy?.draft || state.busy?.reasoning ? (
            <Drafting text={state.busy?.draft ?? ''} reasoning={state.busy?.reasoning ?? ''} />
          ) : (
            <Busy label="正在回答" chars={state.busy?.chars ?? 0} />
          )))}
      </Conversation>

      <div className="dock">
        {needsVerification && <p className="composer-notice" role="status">联网总开关已关闭，本题需要实时核验，当前未核验。{onSearchSettings && <button type="button" className="link" onClick={onSearchSettings}>联网设置</button>}</p>}
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
            tools={(
              <label className="network-mode">
                <span className="sr-only">本题联网方式</span>
                <select value={network} onChange={event => setNetwork(event.target.value as NetworkMode)}>
                  <option value="auto">智能联网</option>
                  <option value="force">本题联网</option>
                  <option value="article">只依据文章</option>
                </select>
              </label>
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
          <SearchSources references={turn.webReferences ?? []} research={turn.research} />
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
