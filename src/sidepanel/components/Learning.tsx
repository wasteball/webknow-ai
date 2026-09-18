import { useEffect, useRef, useState } from 'react';

import type { Command, PanelState, Reply } from '../../core/protocol';
import { Busy, Section, VerdictTag } from './bits';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * “AI 问我”Tab。三种形态：
 * - 空闲（没有学习会话）：学习目标表单；
 * - 进行中：时间线 + 回答输入 + 辅助操作；
 * - 已收束：完整时间线 + 小结，并可再开一轮。
 * 切到别的 Tab 不影响学习会话；这里只负责展示与操作。
 */
export function Learning({ state, send }: { state: PanelState; send: Send }) {
  const [draft, setDraft] = useState('');
  const [goal, setGoal] = useState('');
  const tabId = state.tabId;
  const learning = state.learning;
  const busy = state.busy?.kind === 'learn';
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [learning?.log.length, busy]);

  const answer = async () => {
    if (!tabId || !draft.trim()) return;
    const reply = await send({ type: 'learnAnswer', tabId, text: draft });
    if (reply?.ok) setDraft('');
  };

  const start = async () => {
    if (!tabId) return;
    const reply = await send({ type: 'learnStart', tabId, goal });
    if (reply?.ok) setGoal('');
  };

  return (
    <>
      <Section title="AI 问我">
        {learning && (
          <p className="hint">
            这次要弄清楚「{learning.goal}」。已经问了 {state.budget.used}/{state.budget.total} 个问题
            {state.budget.total - state.budget.used === 0 ? '——问题次数用完了，先给你一个小结。' : '。'}
          </p>
        )}

        {!learning && (
          <p className="hint">
            让 AI 出几个问题考考你，看看这篇文章读懂了没有。它会根据你的回答调整后续问题，
            最后告诉你哪些是你自己答出来的、哪些还没弄清楚。
          </p>
        )}

        {learning && (
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
        )}

        {busy && (
          <Busy
            label={learning?.current ? '正在看你的回答' : '正在想问题'}
            chars={state.busy?.chars ?? 0}
            onStop={() => tabId && void send({ type: 'stop', tabId })}
          />
        )}
        <div ref={endRef} />
      </Section>

      {learning?.status === 'active' ? (
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
      ) : (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          {learning?.status === 'closed' && (
            <p className="hint">这一轮到这里。想继续的话，可以换个方向再来一轮。</p>
          )}
          <label className="sr-only" htmlFor="learning-goal">
            想重点弄清楚什么（可不填）
          </label>
          <input
            id="learning-goal"
            type="text"
            maxLength={200}
            value={goal}
            placeholder={learning?.status === 'closed' ? '下一轮想弄清楚什么（可不填）' : '想重点弄清楚什么？可不填。'}
            disabled={busy}
            onChange={(event) => setGoal(event.target.value)}
          />
          <div className="composer-actions">
            <button type="submit" disabled={busy}>
              {learning?.status === 'closed' ? '再来一轮' : '让 AI 问我'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
