import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

import type { ChatTurn } from '../../core/session';
import type { Quote } from '../../core/quote';
import { evaluateSearchGate } from '../../core/search/gate';
import type { PanelState, Reply } from '../../core/protocol';
import type { Command } from '../../core/protocol';
import { shouldSubmitComposer } from '../composer';
import { visibleSuggestions } from '../suggest';
import { Busy, ComposerField, ComposerTextarea, Drafting, Guard, Opening, SaveButton, ScopeLine, SourceTag, SuggestRow, Thinking } from './bits';
import { Icon } from './Icon';
import { Rich } from './Rich';
import { Conversation } from './Conversation';
import { SearchProgress } from './SearchProgress';
import { SearchLine, SearchSources } from './SearchSources';
import { ResearchClarification } from './ResearchClarification';

type Send = (command: Command) => Promise<Reply | undefined>;

const QUOTE_ONLY_QUESTION = '这段是什么意思？';

/**
 * 「问 AI」：摘要与话题在最上面，点一张卡片就是发出去一句；
 * 下面自己接着问。输入区吸在底部。
 *
 * 回答正文走 <Rich>：模型写的是受控 markdown 子集，这里是它唯一的渲染入口。
 */
export function Reading({ state, send, onSearchSettings, onImaSettings, active = true, searchOn, onSearchChange }: { state: PanelState; send: Send; onSearchSettings?: () => void; onImaSettings?: () => void; active?: boolean; searchOn?: boolean; onSearchChange?: (value: boolean) => void }) {
  const [draft, setDraft] = useState('');
  const openingRef = useRef<HTMLDivElement>(null);
  const [localSearchOn, setLocalSearchOn] = useState(false);
  const effectiveSearchOn = searchOn ?? localSearchOn;
  const setEffectiveSearchOn = onSearchChange ?? setLocalSearchOn;
  const [submitting, setSubmitting] = useState(false);
  const [followRequest, setFollowRequest] = useState(0);
  const [stopping, setStopping] = useState(false);
  const stopInFlight = useRef(false);
  const [hidingSuggests, setHidingSuggests] = useState(false);
  const [hiddenAtTurns, setHiddenAtTurns] = useState(0);
  const [pending, setPending] = useState<{ question: string; quoteText: string | null; at: number } | null>(null);
  const tabId = state.tabId;
  const progress = state.busy?.kind === 'answer' ? state.busy : null;
  const researchPending = state.researchPending;
  const agentIdentity = progress?.agent?.identity;
  const currentAgent = agentIdentity?.tabId === tabId && agentIdentity.sessionId === state.sessionId && agentIdentity.url === state.pageUrl
    ? progress?.agent : undefined;
  const currentPending = state.sessionId && researchPending &&
    (!progress?.agent || (currentAgent && currentAgent.identity.runId === researchPending.runId))
    ? researchPending : undefined;
  const researching = Boolean(currentAgent || currentPending?.status === 'running' || currentPending?.status === 'waiting');
  const busy = Boolean(progress) || submitting || stopping || researching;
  const blocked = state.busy !== null && state.busy.kind !== 'answer';
  const searchEnabled = state.settings.search.enabled;
  const diagrams = state.settings.diagrams === 'auto';
  const guide = state.guide;
  const guideRetryable = state.sessionState === 'READY' && !guide && Boolean(state.error) && !busy;
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
  const needsVerification = !(searchEnabled && effectiveSearchOn) && Boolean(verificationQuestion) && evaluateSearchGate({
    question: verificationQuestion, pageTitle: state.pageTitle, quote: quote?.text ?? null, mode: 'article',
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
  const stop = async () => {
    if (tabId === null || stopInFlight.current) return;
    stopInFlight.current = true;
    setStopping(true);
    try { await send({ type: 'stop', tabId }); }
    finally { stopInFlight.current = false; setStopping(false); }
  };
  const toggleSearch = () => {
    if (stopInFlight.current || (submitting && !researching)) return;
    if (!searchEnabled) { onSearchSettings?.(); return; }
    setEffectiveSearchOn(!effectiveSearchOn);
    if (effectiveSearchOn && researching) void stop();
  };
  const sendQuestion = async (question: string, sentQuote: Quote | null = quote, retry = false, forceSearch = false) => {
    // 有引用时可以不写问题直接发：替用户问最常见的那一句。
    const text = question.trim() || (sentQuote ? QUOTE_ONLY_QUESTION : '');
    if (!tabId || !text || busy || blocked || stopInFlight.current) return;
    concealSuggests();
    setPending({ question: text, quoteText: sentQuote?.text ?? null, at: state.chat.length });
    const sentQuoteKey = sentQuote?.id ?? sentQuote?.text ?? null;
    if (!retry || sentQuoteKey === quoteKey) setConsumedQuote(sentQuoteKey);
    if (!retry) setDraft((current) => (current.trim() === text ? '' : current));
    setSubmitting(true);
    setFollowRequest((n) => n + 1);
    const reply = await send({ type: 'ask', tabId, question: text, search: searchEnabled && (effectiveSearchOn || forceSearch), quote: sentQuote?.text ?? null, ...(sentQuote?.id ? { quoteId: sentQuote.id } : {}) }).finally(() => setSubmitting(false));
    if (reply?.ok) return;
    setConsumedQuote((current) => current === sentQuoteKey ? null : current);
    setPending((current) => (current?.question === text ? null : current));
    setHidingSuggests(false);
    if (!retry) setDraft((current) => (current.trim() ? current : text));
  };
  const ask = (question: string) => void sendQuestion(question);
  // 回答下面的“还是查一下 / 重试 / 联网查一下”：同一个问题这一次一定搜。
  const askWithSearch = (turn: ChatTurn) => void sendQuestion(turn.question, turn.quote ?? null, true, true);
  const searchActions = (turn: ChatTurn) => {
    if (busy || blocked) return null;
    const research = turn.research;
    if (!searchEnabled) return onSearchSettings && !research && turn.unanswered.length > 0
      ? <button type="button" className="link" onClick={onSearchSettings}>打开联网搜索</button> : null;
    if (research?.failure) return <>
      <button type="button" className="link" onClick={() => askWithSearch(turn)}>重试</button>
      {onSearchSettings && <button type="button" className="link" onClick={onSearchSettings}>换一家搜索</button>}
    </>;
    if (research?.noSearchReason) return <button type="button" className="link" onClick={() => askWithSearch(turn)}>还是查一下</button>;
    if (!research && turn.unanswered.length > 0) return <button type="button" className="link" onClick={() => askWithSearch(turn)}>联网查一下</button>;
    return null;
  };
  const canSend = Boolean(draft.trim() || quote);

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) {
      return;
    }
    event.preventDefault();
    if (!busy && !blocked) void ask(draft);
  };

  const sendTopic = async (bubbleId: string, question: string) => {
    if (!tabId || busy || blocked || stopInFlight.current) return;
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
        <PageBar title={state.pageTitle} watch={openingRef} />
        <div ref={openingRef}>
        <Opening pageUrl={state.pageUrl} title={state.pageTitle}>
          {state.completeness && <ScopeLine completeness={state.completeness}
            onJump={(blockId) => tabId !== null && void send({ type: 'jump', tabId, blockId })} />}
          {guide ? (
            <div className="opening-summary said-guide">
              <Thinking text={guide.reasoning ?? ''} />
              <Rich text={guide.summary} diagrams={false} />
              <SaveButton connected={state.settings.saveTo !== null} kbName={state.settings.saveTo?.name ?? null} tabId={tabId}
                send={send} onConnect={onImaSettings} disabled={state.busy !== null} />
            </div>
          ) : guideRetryable && tabId !== null ? (
            <p className="opening-note" role="status">
              摘要暂时没生成，但你仍然可以直接提问。{' '}
              <button type="button" className="link" onClick={() => void send({ type: 'start', tabId })}>
                重试摘要
              </button>
            </p>
          ) : null}
        </Opening>
        </div>
        {guide && (
          <SuggestRow
            lead="想接着弄懂哪一点"
            items={row.openers}
            disabled={busy || blocked}
            onPick={(item) => void sendTopic(item.id, item.question)}
          />
        )}

        {state.chat.map((turn) => (
          <Guard key={turn.id}><Turn turn={turn} tabId={tabId} send={send} diagrams={diagrams} searchActions={searchActions(turn)} /></Guard>
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
        {!stopping && currentPending && state.sessionId && tabId !== null && <ResearchClarification
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
        {needsVerification && <p className="composer-notice" role="status">联网搜索未开启，本题需要实时核验，当前未核验。{onSearchSettings && <button type="button" className="link" onClick={onSearchSettings}>联网设置</button>}</p>}
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
            submitDisabled={blocked || !canSend}
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
                aria-pressed={searchEnabled && effectiveSearchOn}
                disabled={stopping || (submitting && !researching)}
                title={searchEnabled
                  ? `打开后，只把搜索词发给${state.settings.search.providerName ?? '搜索服务'}，不发这一页正文`
                  : '先选择一个联网搜索服务'}
                onClick={toggleSearch}
              >
                <Icon name="globe" small />
                联网搜索
                {searchEnabled && effectiveSearchOn && <Icon name="check" small />}
              </button>
            )}
          >
            <ComposerTextarea
              id="question"
              value={draft}
              rows={2}
              maxLength={500}
              placeholder={quote ? '想问这段什么？不写也行，直接发送' : '哪里不懂，直接问'}
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
  searchActions,
}: {
  turn: ChatTurn;
  tabId: number | null;
  send: Send;
  diagrams: boolean;
  searchActions?: React.ReactNode;
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
            <p className="cites">
              {turn.citations.map((citation, index) => (
                <button
                  key={citation.blockId}
                  type="button"
                  className="cite"
                  aria-label={`回到文中 ${index + 1}`}
                  title="在网页上定位到这段"
                  onClick={() => tabId && void send({ type: 'jump', tabId, blockId: citation.blockId })}
                >
                  <Icon name="quote" small />
                  原文 {index + 1}
                </button>
              ))}
            </p>
          )}
          <SearchLine research={turn.research} references={turn.webReferences ?? []} actions={searchActions} />
          {!turn.research && searchActions && <p className="search-line">{searchActions}</p>}
          <SearchSources references={turn.webReferences ?? []} research={turn.research} />
          {turn.unanswered.length > 0 && (
            <div className="aside">
              <b>文章没写：</b>
              <ul className="unanswered">
                {turn.unanswered.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </article>
    </>
  );
}

/**
 * “这一页”折叠条（重构方案 4.3）：开场卡滚出视野后，在对话区顶部吸一行标题，点一下回到开场卡。
 * 用 IntersectionObserver 判断，不监听滚动事件。
 */
function PageBar({ title, watch }: { title: string; watch: RefObject<HTMLDivElement | null> }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const target = watch.current;
    if (!target || typeof IntersectionObserver === 'undefined') return;
    // 滚动发生在对话容器里，不是整页：以它为视口来判断开场卡是否已滚走。
    const root = target.closest('.chat-scroll');
    const observer = new IntersectionObserver(([entry]) => setShown(entry ? !entry.isIntersecting : false), { root, threshold: 0 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [watch]);
  if (!shown || !title) return null;
  return (
    <button type="button" className="page-bar" title="回到这一页的摘要"
      onClick={() => watch.current?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}>
      <span className="page-bar-k">这一页</span>
      <span className="page-bar-title">{title}</span>
    </button>
  );
}
