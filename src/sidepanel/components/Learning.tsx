import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { DEFAULT_LEARN_GOAL, usedLearnGoals } from '../../core/learn-policy';
import type { Command, PanelState, Reply } from '../../core/protocol';
import type { LearnEntry, QuizQuestion } from '../../core/session';
import { shouldSubmitComposer } from '../composer';
import { Busy, Section, VerdictTag } from './bits';
import { Icon } from './Icon';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 「问我」面板。四种形态：
 * - 空闲（没有学习会话）：学习目标表单；
 * - 开放问题进行中：时间线 + 回答输入 + 辅助操作；
 * - 选择题轮进行中：直接在题目上勾选并提交；
 * - 已收束：完整时间线 + 小结，并可再开一轮。
 * 时间线在滚动区，当前能做的动作固定在底部；切到别的模式不影响学习会话。
 */
export function Learning({ state, send }: { state: PanelState; send: Send }) {
  const [draft, setDraft] = useState('');
  const [goal, setGoal] = useState('');
  const [sentGoals, setSentGoals] = useState<Set<string>>(new Set());
  /** 当前选择题轮的作答：questionId → 选中的选项 id。 */
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const tabId = state.tabId;
  const learning = state.learning;
  const busy = state.busy?.kind === 'learn';
  const endRef = useRef<HTMLDivElement>(null);

  // 同上：只有新的一轮出现时才跟到底部，挂载时停在时间线开头（目标与预算在那里）。
  const seen = useRef({ entries: learning?.log.length ?? 0, busy });
  useEffect(() => {
    const entries = learning?.log.length ?? 0;
    if (entries > seen.current.entries || (busy && !seen.current.busy)) {
      endRef.current?.scrollIntoView({ block: 'end' });
    }
    seen.current = { entries, busy };
  }, [learning?.log.length, busy]);

  useEffect(() => {
    // 轮次切换时清空作答草稿。
    setPicks({});
    setDraft('');
  }, [learning?.current, learning?.log.length]);

  const current = learning?.current ?? null;
  const quiz = current?.kind === 'quiz' ? current.questions : null;
  const allAnswered = quiz !== null && quiz.every((question) => (picks[question.id] ?? []).length > 0);
  // 有学习请求在飞时不摆动作区：这期间所有操作都会被后台挡回来，摆出来只会让人白点。
  const showDock = !busy;

  const answer = async () => {
    if (!tabId || !draft.trim()) return;
    const reply = await send({ type: 'learnAnswer', tabId, text: draft });
    if (reply?.ok) setDraft('');
  };

  const submitQuiz = async () => {
    if (!tabId || !quiz) return;
    const choices = quiz.map((question) => ({ questionId: question.id, choiceIds: picks[question.id] ?? [] }));
    const reply = await send({ type: 'learnAnswer', tabId, text: '（选择题作答）', choices });
    if (reply?.ok) setPicks({});
  };

  const startWith = async (nextGoal: string) => {
    if (!tabId) return;
    const sent = nextGoal.trim() || DEFAULT_LEARN_GOAL;
    setSentGoals((current) => new Set(current).add(sent));
    const reply = await send({ type: 'learnStart', tabId, goal: sent });
    if (reply?.ok) setGoal('');
    else {
      setSentGoals((current) => {
        const next = new Set(current);
        next.delete(sent);
        return next;
      });
    }
  };

  const start = async () => {
    await startWith(goal);
  };

  const usedGoals = new Set([...usedLearnGoals(learning), ...sentGoals]);
  const topics = (state.guide?.bubbles ?? []).filter((bubble) => !usedGoals.has(bubble.question));
  const showCore = !usedGoals.has(DEFAULT_LEARN_GOAL);

  const togglePick = (question: QuizQuestion, choiceId: string) => {
    setPicks((currentPicks) => {
      const existing = currentPicks[question.id] ?? [];
      if (question.multi) {
        return {
          ...currentPicks,
          [question.id]: existing.includes(choiceId)
            ? existing.filter((id) => id !== choiceId)
            : [...existing, choiceId],
        };
      }
      return { ...currentPicks, [question.id]: [choiceId] };
    });
  };

  return (
    <>
      <Section title={learning ? `正在问：${learning.goal}` : '点一张，它开始问你'}>
        {learning && (
          <p className="hint">
            已经问了 {state.budget.used}/{state.budget.total} 轮
            {state.budget.total - state.budget.used === 0 ? '——次数用完了，先给你一个小结。' : '。卡住了就点「我不知道」。'}
          </p>
        )}

        {!learning && (
          <p className="hint">一次只问一件事。你答、它再问；不会的话可以说不知道，它会先给提示。</p>
        )}

        {learning && (
          <ol className="timeline">
            {learning.log.map((entry, index) => (
              <li key={`${entry.role}-${entry.at}-${index}`} className={`entry entry-${entry.role}`}>
                {entry.role === 'question' && <p className="question">{entry.text}</p>}
                {entry.role === 'quiz' && <QuizEntryView entry={entry} />}
                {entry.role === 'answer' && <YourAnswer entry={entry} />}
                {entry.role === 'feedback' && (
                  <p className="answer">
                    {entry.verdict && <VerdictTag verdict={entry.verdict} />}
                    {entry.score && (
                      <span className="tag">
                        {entry.score.correct}/{entry.score.total} 题正确
                      </span>
                    )}
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
            label={current ? (current.kind === 'quiz' ? '正在批改这一轮' : '正在看你的回答') : '正在想问题'}
            chars={state.busy?.chars ?? 0}
            onStop={() => tabId && void send({ type: 'stop', tabId })}
          />
        )}
        <div ref={endRef} />
      </Section>

      {/* 底部固定区：只放"现在能做的动作"，滚到时间线哪一段都能作答。 */}
      {showDock && (
        <div className="dock">
          {quiz && learning?.status === 'active' && (
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void submitQuiz();
              }}
            >
              {quiz.map((question, questionIndex) => (
                <fieldset className="quiz-question" key={question.id}>
                  <legend>
                    {questionIndex + 1}. {question.text}
                    {question.multi && <span className="tag">可多选</span>}
                  </legend>
                  {question.choices.map((choice) => (
                    <label key={choice.id} className="quiz-option">
                      <input
                        type={question.multi ? 'checkbox' : 'radio'}
                        name={`quiz-${question.id}`}
                        checked={(picks[question.id] ?? []).includes(choice.id)}
                        onChange={() => togglePick(question, choice.id)}
                      />
                      <span>{choice.label}</span>
                    </label>
                  ))}
                </fieldset>
              ))}
              <div className="composer-actions">
                <button type="submit" disabled={!allAnswered}>
                  <Icon name="check" small />
                  提交答案
                </button>
              </div>
            </form>
          )}

          {current?.kind === 'open' && learning?.status === 'active' && (
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
                  placeholder="用自己的话说说看… Enter 发送，Shift+Enter 换行"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                    if (
                      !shouldSubmitComposer({
                        key: event.key,
                        shiftKey: event.shiftKey,
                        isComposing: event.nativeEvent.isComposing,
                        keyCode: event.keyCode,
                      })
                    ) {
                      return;
                    }
                    event.preventDefault();
                    void answer();
                  }}
                />
                <div className="composer-actions">
                  <button type="submit" disabled={!draft.trim()}>
                    <Icon name="send" small />
                    回答
                  </button>
                </div>
              </form>
              <div className="composer-actions" role="group" aria-label="学习辅助">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => tabId && void send({ type: 'learnAssist', tabId, action: 'unknown' })}
                >
                  我不知道
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => tabId && void send({ type: 'learnAssist', tabId, action: 'hint' })}
                >
                  给我提示
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => tabId && void send({ type: 'learnAssist', tabId, action: 'explain' })}
                >
                  直接讲解
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => tabId && void send({ type: 'learnAssist', tabId, action: 'skip' })}
                >
                  跳过
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => tabId && void send({ type: 'learnEnd', tabId })}
                >
                  结束学习
                </button>
              </div>
            </>
          )}

          {current?.kind === 'quiz' && learning?.status === 'active' && (
            <div className="composer-actions" role="group" aria-label="学习辅助">
              <button
                type="button"
                className="quiet"
                onClick={() => tabId && void send({ type: 'learnAssist', tabId, action: 'explain' })}
              >
                直接讲解
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => tabId && void send({ type: 'learnAssist', tabId, action: 'skip' })}
              >
                跳过这一轮
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => tabId && void send({ type: 'learnEnd', tabId })}
              >
                结束学习
              </button>
            </div>
          )}

          {learning?.status === 'active' && !current && (
            <p className="hint">等一下，马上出下一轮…</p>
          )}

          {(!learning || learning.status === 'closed') && (
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void start();
              }}
            >
              {learning?.status === 'closed' && (
                <p className="hint">这一轮到这里。想继续的话，换一个点再来一轮。</p>
              )}
              <p className="chip-lead">
                {learning?.status === 'closed' ? '换一个点再来一轮，点一张就发出去：' : '先选要弄懂的那一点：'}
              </p>
              <div className="chiprow topic-picker">
                {showCore && (
                  <button
                    type="button"
                    className="chip chip-learn"
                    onClick={() => void startWith(DEFAULT_LEARN_GOAL)}
                  >
                    <span className="chip-text">这篇文章的核心内容</span>
                    <span className="chip-go">开始</span>
                  </button>
                )}
                {topics.map((bubble) => (
                  <button
                    key={bubble.id}
                    type="button"
                    className="chip"
                    onClick={() => void startWith(bubble.question)}
                  >
                    <span className="chip-text">{bubble.question}</span>
                    <span className="chip-go">开始</span>
                  </button>
                ))}
              </div>
              <label className="sr-only" htmlFor="learning-goal">
                自己写一个方向（可不填）
              </label>
              <input
                id="learning-goal"
                type="text"
                maxLength={200}
                value={goal}
                placeholder="或者自己写一个方向（可不填）"
                onChange={(event) => setGoal(event.target.value)}
              />
              <div className="composer-actions">
                <button type="submit">
                  {learning?.status === 'closed' && <Icon name="rotate" small />}
                  {learning?.status === 'closed' ? '再来一轮' : '开始'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </>
  );
}

/**
 * 你自己的那句回答。
 * 选择题轮里后台存的是「题目｜我的答案：xxx」（多选题之间用换行分隔），
 * 这里拆成问答两行，读起来才像一次对话，而不是一行流水账。
 * 拆不开（开放问答本来就是自由文本）就照原样显示——格式变了也不会显示错。
 */
function YourAnswer({ entry }: { entry: LearnEntry }) {
  const label = entry.independent ? '自己答出来的' : '看了提示才答出来的';
  return (
    <div className="your-answer">
      <span className="tag">{label}</span>
      {entry.text.split('\n').map((line) => {
        const [question, picked] = line.split('｜我的答案：');
        if (picked === undefined) return <p key={line}>{question}</p>;
        return (
          <p className="qa-line" key={line}>
            <span className="qa-q">{question}</span>
            <span className="qa-a">{picked}</span>
          </p>
        );
      })}
    </div>
  );
}

/** 历史时间线里的选择题轮：只展示题目与选项（作答与判定在下一条记录里）。 */
function QuizEntryView({ entry }: { entry: LearnEntry }) {
  return (
    <div>
      {entry.quiz?.map((question, index) => (
        <div key={question.id} className="quiz-past">
          <p className="question">
            {index + 1}. {question.text}
          </p>
          <p className="hint">{question.choices.map((choice) => choice.label).join(' / ')}</p>
        </div>
      ))}
    </div>
  );
}
