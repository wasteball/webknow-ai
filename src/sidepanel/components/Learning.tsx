import { useEffect, useRef, useState } from 'react';

import type { Command, PanelState, Reply } from '../../core/protocol';
import { Busy, Section, VerdictTag } from './bits';

type Send = (command: Command) => Promise<Reply | undefined>;

export function Learning({ state, send }: { state: PanelState; send: Send }) {
  const [draft, setDraft] = useState('');
  const tabId = state.tabId;
  const learning = state.learning;
  const busy = state.busy?.kind === 'learn';
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [learning?.log.length, busy]);

  if (!learning) return null;
  const remaining = Math.max(0, state.budget.total - state.budget.used);
  const closed = learning.status === 'closed';

  const answer = async () => {
    if (!tabId || !draft.trim()) return;
    const reply = await send({ type: 'learnAnswer', tabId, text: draft });
    if (reply?.ok) setDraft('');
  };

  return (
    <>
      <Section title="AI 问我">
        <p className="hint">
          这次要弄清楚「{learning.goal}」。已经问了 {state.budget.used}/{state.budget.total} 个问题
          {remaining === 0 ? '——问题次数用完了，先给你一个小结。' : '。'}
        </p>

        <ol className="timeline">
          {learning.log.map((entry, index) => (
            <li key={`${entry.role}-${entry.at}-${index}`} className={`entry entry-${entry.role}`}>
              {entry.role === 'question' && <p className="question">{entry.text}</p>}
              {entry.role === 'answer' && (
                <p className="your-answer">
                  <span className="tag">{entry.independent ? '自己答出来的' : '看了提示才答出来的'}</span>
                  {entry.text}
                </p>
              )}
              {entry.role === 'feedback' && (
                <p className="answer">
                  {entry.verdict && <VerdictTag verdict={entry.verdict} />}
                  {entry.text}
                </p>
              )}
              {entry.role === 'hint' && <p className="hint-line">提示：{entry.text}</p>}
              {entry.role === 'explain' && <p className="explain">讲解：{entry.text}</p>}
              {entry.role === 'skip' && <p className="skip">{entry.text}</p>}
              {entry.role === 'summary' && <p className="summary">{entry.text}</p>}
              {entry.role === 'note' && <p className="hint">{entry.text}</p>}
            </li>
          ))}
        </ol>

        {busy && (
          <Busy
            label={learning.current ? '正在看你的回答' : '正在想问题'}
            chars={state.busy?.chars ?? 0}
            onStop={() => tabId && void send({ type: 'stop', tabId })}
          />
        )}
        <div ref={endRef} />
      </Section>

      {closed ? (
        <div className="composer-actions">
          <button type="button" onClick={() => tabId && void send({ type: 'learnExit', tabId })}>
            回到问答
          </button>
        </div>
      ) : (
        <>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void answer();
            }}
          >
            <label className="sr-only" htmlFor="learning-answer">
              用自己的话回答
            </label>
            <textarea
              id="learning-answer"
              rows={2}
              maxLength={1000}
              value={draft}
              placeholder={learning.current ? '用自己的话说说看…' : '等一下，马上提问…'}
              disabled={!learning.current || busy}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="composer-actions">
              <button type="submit" disabled={busy || !draft.trim() || !learning.current}>
                回答
              </button>
            </div>
          </form>
          <div className="composer-actions" role="group" aria-label="学习辅助">
            <button
              type="button"
              className="quiet"
              disabled={busy || !learning.current}
              onClick={() => tabId && void send({ type: 'learnAssist', tabId, action: 'hint' })}
            >
              给我提示
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy || !learning.current}
              onClick={() => tabId && void send({ type: 'learnAssist', tabId, action: 'explain' })}
            >
              直接讲解
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => tabId && void send({ type: 'learnAssist', tabId, action: 'skip' })}
            >
              跳过
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => tabId && void send({ type: 'learnEnd', tabId })}
            >
              结束学习
            </button>
          </div>
        </>
      )}
    </>
  );
}
