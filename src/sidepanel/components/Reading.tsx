import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { ChatTurn } from '../../core/session';
import type { PanelState, Reply } from '../../core/protocol';
import type { Command } from '../../core/protocol';
import { shouldSubmitComposer } from '../composer';
import { Busy, SourceTag } from './bits';
import { Icon } from './Icon';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 「我问」：摘要与话题在最上面，点一张卡片就是发出去一句；
 * 下面自己接着问。输入区吸在底部。
 */
export function Reading({ state, send }: { state: PanelState; send: Send }) {
  const [draft, setDraft] = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  const tabId = state.tabId;
  const endRef = useRef<HTMLDivElement>(null);
  const busy = state.busy?.kind === 'answer';
  const searchEnabled = state.settings.search.enabled;
  const guide = state.guide;

  // 只在对话真的往下走时跟到底部。挂载时不滚：这一栏开头是摘要与话题，
  // 一进来就被推到最后一轮问答上，等于把最重要的内容藏起来了。
  const seen = useRef({ turns: state.chat.length, busy });
  useEffect(() => {
    if (state.chat.length > seen.current.turns || (busy && !seen.current.busy)) {
      endRef.current?.scrollIntoView({ block: 'end' });
    }
    seen.current = { turns: state.chat.length, busy };
  }, [state.chat.length, busy]);

  const ask = async (question: string) => {
    if (!tabId || !question.trim()) return;
    const reply = await send({ type: 'ask', tabId, question, search: searchEnabled && searchOn });
    if (reply?.ok) setDraft('');
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) {
      return;
    }
    event.preventDefault();
    if (!busy) void ask(draft);
  };

  // 问过的话题就退休：ChatTurn 里没有 bubbleId（explore 在下游退化成了一次普通提问），
  // 所以按问题原文匹配。这也正好是用户看到的"我问过了"。
  const asked = new Set(state.chat.map((turn) => turn.question));
  const openTopics =
    guide?.bubbles.filter((bubble) => !asked.has(bubble.question) && !sentIds.has(bubble.id)) ?? [];

  const sendTopic = async (bubbleId: string) => {
    if (!tabId) return;
    setSentIds((current) => new Set(current).add(bubbleId));
    const reply = await send({ type: 'explore', tabId, bubbleId });
    if (!reply?.ok) {
      setSentIds((current) => {
        const next = new Set(current);
        next.delete(bubbleId);
        return next;
      });
    }
  };

  return (
    <>
      {guide && (
        <article className="msg ai">
          <div className="bubble ai bubble-guide">
            <h2 id="guide-heading">这篇文章讲了什么</h2>
            <p className="summary">{guide.summary}</p>
            {openTopics.length > 0 && (
              <div className="chiprow">
                <p className="chip-lead">想接着弄懂，点一张发出去：</p>
                {openTopics.map((bubble) => (
                  <button
                    key={bubble.id}
                    type="button"
                    className="chip"
                    disabled={busy}
                    onClick={() => void sendTopic(bubble.id)}
                  >
                    <span className="chip-text">{bubble.question}</span>
                    <span className="chip-go">发出去</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </article>
      )}

      <div className="chat">
        {guide && state.chat.length === 0 && !busy && openTopics.length === 0 && (
          <p className="hint">话题都聊完了。下面接着问就行。</p>
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
      </div>

      <div className="dock">
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
            placeholder="把问题写在这里。Enter 发送"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <div className="composer-actions">
            {searchEnabled && (
              <button
                type="button"
                className="search-chip"
                aria-pressed={searchOn}
                title={`打开后，只把搜索词发给${state.settings.search.providerName ?? '搜索服务'}，不发这一页正文`}
                onClick={() => setSearchOn((current) => !current)}
              >
                联网搜索
              </button>
            )}
            <button type="submit" disabled={busy || !draft.trim()}>
              <Icon name="send" small />
              发送
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

/** 一轮问答 = 你的气泡 + AI 的气泡，和上面摘要那条连成一段对话。 */
function Turn({ turn, tabId, send }: { turn: ChatTurn; tabId: number | null; send: Send }) {
  return (
    <>
      <article className="msg user">
        <div className="bubble user">{turn.question}</div>
      </article>
      <article className="msg ai">
        <div className="bubble ai">
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
