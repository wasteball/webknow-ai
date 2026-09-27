import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { DEFAULT_LEARN_GOAL, usedLearnGoals } from '../../core/learn-policy';
import type { Command, PanelState, Reply } from '../../core/protocol';
import type { LearnEntry, QuizQuestion } from '../../core/session';
import { shouldSubmitComposer } from '../composer';
import { Busy, ComposerField, Drafting, SuggestRow, Thinking, VerdictTag } from './bits';
import { Icon } from './Icon';
import { Rich, RichInline } from './Rich';

type Send = (command: Command) => Promise<Reply | undefined>;

/**
 * 「AI 问」面板。四种形态：
 * - 空闲（没有学习会话）：先选要弄懂的那一点；
 * - 开放问题进行中：对话流 + 回答输入 + 辅助操作；
 * - 选择题轮进行中：直接在题目上勾选并提交；
 * - 已收束：完整对话流 + 小结 + 下一轮方向卡片。
 *
 * 呈现与「问 AI」同一套气泡语言（你说的话靠右成泡，它说的话靠左是正文），
 * 用户学一次交互就够。会话数据仍与「问 AI」分开，切模式不中断。
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
  const diagrams = state.settings.diagrams === 'auto';
  const endRef = useRef<HTMLDivElement>(null);

  // 同上：只有新的一轮出现时才跟到底部，挂载时停在开头（目标与预算在那里）。
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

  const stop = () => {
    if (tabId) void send({ type: 'stop', tabId });
  };
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

  const usedGoals = new Set([...usedLearnGoals(learning), ...sentGoals]);
  const topics = (state.guide?.bubbles ?? []).filter((bubble) => !usedGoals.has(bubble.question));
  const showCore = !usedGoals.has(DEFAULT_LEARN_GOAL);
  const starters = [
    ...(showCore ? [{ id: 'core', question: '这篇文章的核心内容' }] : []),
    ...topics.map((bubble) => ({ id: bubble.id, question: bubble.question })),
  ];

  // 收束后的「换一个点再来一轮」：模型给的方向优先，没给就回到话题列表。
  const closingEntry = learning?.status === 'closed' ? learning.log[learning.log.length - 1] : null;
  const nextDirections =
    closingEntry?.role === 'summary' && learning?.nextDirections?.length
      ? learning.nextDirections.map((text, index) => ({ id: `dir_${index}`, question: text }))
      : starters;

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
      <div className="chat">
        {learning ? (
          <>
            <p className="learn-head">
              正在问：{learning.goal}
              <span className="learn-budget">
                {state.budget.used}/{state.budget.total} 轮
              </span>
            </p>
            {learning.log.map((entry, index) => (
              <Entry key={`${entry.role}-${entry.at}-${index}`} entry={entry} diagrams={diagrams} />
            ))}
          </>
        ) : (
          <p className="learn-head">
            它来问你，你来答。答不上来就说不知道，它会先给提示。
          </p>
        )}

        {busy &&
          (state.busy?.draft || state.busy?.reasoning ? (
            <Drafting text={state.busy?.draft ?? ''} reasoning={state.busy?.reasoning ?? ''} />
          ) : (
            <Busy
              label={current ? (current.kind === 'quiz' ? '正在批改这一轮' : '正在看你的回答') : '正在想问题'}
              chars={state.busy?.chars ?? 0}
            />
          ))}
        <div className="chat-end" ref={endRef} />
      </div>

      {/* 底部固定区：生成时也留着。停止和提交是同一个位置，正文只显示正在写的内容。 */}
      <div className="dock">
          {quiz && learning?.status === 'active' && (
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void submitQuiz();
              }}
            >
              {quiz.map((question, questionIndex) => (
                <fieldset className="quiz-question" key={question.id}>
                  <legend>
                    {questionIndex + 1}. <RichInline text={question.text} />
                    {question.multi && <span className="tag">可多选</span>}
                  </legend>
                  {question.choices.map((choice) => (
                    <label key={choice.id} className="quiz-option">
                      <input
                        type={question.multi ? 'checkbox' : 'radio'}
                        name={`quiz-${question.id}`}
                        checked={(picks[question.id] ?? []).includes(choice.id)}
                        disabled={busy}
                        onChange={() => togglePick(question, choice.id)}
                      />
                      <span>
                        <RichInline text={choice.label} />
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
              <div className="composer-actions">
                <Assists tabId={tabId} send={send} only={['explain', 'skip', 'end']} disabled={busy} />
                {busy ? (
                  <button type="button" className="send-btn" aria-label="停止" onClick={stop}>
                    <Icon name="stop" small />
                  </button>
                ) : (
                  <button type="submit" disabled={!allAnswered}>
                    <Icon name="check" small />
                    提交
                  </button>
                )}
              </div>
            </form>
          )}

          {current?.kind === 'open' && learning?.status === 'active' && (
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void answer();
              }}
            >
              <label className="sr-only" htmlFor="learning-answer">
                用自己的话回答
              </label>
              <ComposerField busy={busy} idleLabel="回答" onStop={stop}>
                <textarea
                  id="learning-answer"
                  rows={2}
                  maxLength={1000}
                  value={draft}
                  placeholder="用自己的话说说看…"
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
                    if (!busy) void answer();
                  }}
                />
              </ComposerField>
              <div className="composer-actions">
                <Assists tabId={tabId} send={send} only={['unknown', 'hint', 'explain', 'skip', 'end']} disabled={busy} />
              </div>
            </form>
          )}

          {learning?.status === 'active' && !current &&
            (busy ? (
              <form className="composer" onSubmit={(event) => event.preventDefault()}>
                <ComposerField busy idleLabel="回答" onStop={stop}>
                  <textarea rows={2} readOnly placeholder="正在想下一问" aria-label="正在想下一问" />
                </ComposerField>
              </form>
            ) : (
              <p className="hint">等一下，马上出下一轮…</p>
            ))}

          {(!learning || learning.status === 'closed') && (
            <>
              <SuggestRow
                lead={learning?.status === 'closed' ? '换一个点再来一轮' : '先选要弄懂的那一点'}
                items={nextDirections}
                disabled={busy}
                onPick={(item) => void startWith(item.id === 'core' ? DEFAULT_LEARN_GOAL : item.question)}
              />
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy) void startWith(goal);
                }}
              >
                <label className="sr-only" htmlFor="learning-goal">
                  自己写一个方向
                </label>
                <ComposerField
                  busy={busy}
                  idleLabel="开始"
                  idleIcon={learning?.status === 'closed' ? 'rotate' : 'send'}
                  onStop={stop}
                >
                  <input
                    id="learning-goal"
                    type="text"
                    maxLength={200}
                    value={goal}
                    placeholder="或者自己写一个方向"
                    onChange={(event) => setGoal(event.target.value)}
                  />
                </ComposerField>
              </form>
            </>
          )}
      </div>
    </>
  );
}

const ASSIST_LABEL = {
  unknown: '我不知道',
  hint: '提示',
  explain: '讲解',
  skip: '跳过',
  end: '结束',
} as const;

/** 辅助操作一律同一层级的弱按钮：混着主次两种按钮会让人不知道该点哪个。 */
function Assists({
  tabId,
  send,
  only,
  disabled = false,
}: {
  tabId: number | null;
  send: Send;
  only: (keyof typeof ASSIST_LABEL)[];
  disabled?: boolean;
}) {
  return (
    <>
      {only.map((action) => (
        <button
          key={action}
          type="button"
          className="quiet"
          disabled={disabled}
          onClick={() =>
            tabId &&
            void send(
              action === 'end'
                ? { type: 'learnEnd', tabId }
                : { type: 'learnAssist', tabId, action },
            )
          }
        >
          {ASSIST_LABEL[action]}
        </button>
      ))}
    </>
  );
}

/**
 * 一条记录 → 一条消息。
 * 你说的话靠右成泡；它说的话靠左是正文；跳过与旁注走中缝细字，不占对话位。
 */
function Entry({ entry, diagrams }: { entry: LearnEntry; diagrams: boolean }) {
  if (entry.role === 'skip' || entry.role === 'note') {
    return (
      <>
        <Thinking text={entry.reasoning ?? ''} />
        <p className="aside">{entry.text}</p>
      </>
    );
  }

  if (entry.role === 'answer') {
    return (
      <article className="msg user">
        <div className="bubble user">
          <YourAnswer entry={entry} />
        </div>
      </article>
    );
  }

  return (
    <article className="msg ai">
      <Thinking text={entry.reasoning ?? ''} />
      <div className={`said${entry.role === 'summary' ? ' said-summary' : ''}`}>
        {entry.role === 'question' && <Rich text={entry.text} diagrams={false} />}
        {entry.role === 'quiz' && <QuizEntryView entry={entry} />}
        {entry.role === 'feedback' && (
          <>
            {entry.verdict && <VerdictTag verdict={entry.verdict} />}
            {entry.score && (
              <span className="tag">
                {entry.score.correct}/{entry.score.total} 题正确
              </span>
            )}
            <Rich text={entry.text} diagrams={diagrams} />
          </>
        )}
        {entry.role === 'hint' && (
          <>
            <span className="tag">提示</span>
            <Rich text={entry.text} diagrams={false} />
          </>
        )}
        {entry.role === 'explain' && <Rich text={entry.text} diagrams={diagrams} />}
        {entry.role === 'summary' && (
          <>
            <span className="tag">小结</span>
            <Rich text={entry.text} diagrams={diagrams} />
          </>
        )}
      </div>
    </article>
  );
}

/**
 * 你自己的那句回答。
 * 选择题轮里后台存的是「题目｜我的答案：xxx」（多选题之间用换行分隔），
 * 这里拆成问答两行，读起来才像一次对话，而不是一行流水账。
 * 拆不开（开放问答本来就是自由文本）就照原样显示——格式变了也不会显示错。
 */
function YourAnswer({ entry }: { entry: LearnEntry }) {
  return (
    <>
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
      {/* 看了提示才答出来的那一轮必须留痕（FR-014）；自己答出来的不用每次夸。 */}
      {entry.independent === false && <span className="qa-assisted">看了提示</span>}
    </>
  );
}

/** 历史对话里的选择题轮：只展示题目与选项（作答与判定在下一条记录里）。 */
function QuizEntryView({ entry }: { entry: LearnEntry }) {
  return (
    <>
      {entry.quiz?.map((question, index) => (
        <div key={question.id} className="quiz-past">
          <p>
            {index + 1}. <RichInline text={question.text} />
          </p>
          <p className="hint">{question.choices.map((choice) => choice.label).join(' / ')}</p>
        </div>
      ))}
    </>
  );
}
