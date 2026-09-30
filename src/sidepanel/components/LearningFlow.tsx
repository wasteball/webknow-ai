import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { DEFAULT_LEARN_GOAL, usedLearnGoals } from '../../core/learn-policy';
import type { Command, PanelState, Reply } from '../../core/protocol';
import type { QuizQuestion } from '../../core/session';
import { shouldSubmitComposer } from '../composer';
import { Busy, ComposerField, ComposerTextarea, Drafting, SuggestRow } from './bits';
import { Conversation } from './Conversation';
import { LearningEntry as Entry } from './LearningEntry';
import { QuizMessage } from './QuizMessage';
import { Rich } from './Rich';

type Send = (command: Command) => Promise<Reply | undefined>;

/** 题目、选项与反馈都是消息；底部只承担输入和当前操作。 */
export function Learning({ state, send, active = true }: { state: PanelState; send: Send; active?: boolean }) {
  const [draft, setDraft] = useState('');
  const autoStarted = useRef(false);
  const [startFailed, setStartFailed] = useState(false);
  const [goal, setGoal] = useState('');
  const [sentGoals, setSentGoals] = useState<Set<string>>(new Set());
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [pending, setPending] = useState<{ text: string; at: number } | null>(null);
  const [pendingGoal, setPendingGoal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [followRequest, setFollowRequest] = useState(0);
  const learning = state.learning;
  const current = learning?.current ?? null;
  const tabId = state.tabId;
  const busy = state.busy?.kind === 'learn' || submitting;
  const blocked = state.busy !== null && state.busy.kind !== 'learn';
  const diagrams = state.settings.diagrams === 'auto';
  const quiz = current?.kind === 'quiz' ? current.questions : null;
  const inRound = learning?.status === 'active';
  const closed = learning?.status === 'closed';
  const signature = `${learning?.used}:${current?.kind === 'open' ? current.question : JSON.stringify(quiz ?? [])}`;
  useEffect(() => { setPicks({}); }, [signature]);
  const selectedCount = quiz?.filter((q) => (picks[q.id] ?? []).length > 0).length ?? 0;
  const allAnswered = quiz !== null && selectedCount === quiz.length;

  const stop = () => { if (tabId !== null) void send({ type: 'stop', tabId }); };
  const answer = async () => {
    if (tabId === null || !draft.trim() || busy || blocked) return;
    const text = draft.trim();
    setPending({ text, at: learning?.log.length ?? 0 });
    setDraft('');
    setSubmitting(true);
    setFollowRequest((n) => n + 1);
    try {
      const reply = await send({ type: 'learnAnswer', tabId, text });
      if (!reply?.ok) { setPending(null); setDraft((value) => value || text); }
    } finally { setSubmitting(false); }
  };
  const submitQuiz = async () => {
    if (tabId === null || !quiz || !allAnswered || busy || blocked) return;
    const choices = quiz.map((q) => ({ questionId: q.id, choiceIds: picks[q.id] ?? [] }));
    const text = quiz.map((q) => q.choices.filter((choice) => (picks[q.id] ?? []).includes(choice.id)).map((choice) => choice.label).join('、')).join('\n');
    setPending({ text, at: learning?.log.length ?? 0 });
    setSubmitting(true);
    setFollowRequest((n) => n + 1);
    try {
      const reply = await send({ type: 'learnAnswer', tabId, text: '（选择题作答）', choices });
      if (!reply?.ok) setPending(null);
    } finally { setSubmitting(false); }
  };
  const startWith = async (nextGoal: string, automatic = false) => {
    if (tabId === null || busy || blocked) return;
    autoStarted.current = true;
    setStartFailed(false);
    const sent = nextGoal.trim() || DEFAULT_LEARN_GOAL;
    setSentGoals((goals) => new Set(goals).add(sent));
    setPendingGoal(automatic ? null : sent);
    setGoal('');
    setSubmitting(true);
    setFollowRequest((n) => n + 1);
    try {
      const reply = await send({ type: 'learnStart', tabId, goal: sent });
      if (!reply?.ok) {
        setStartFailed(true);
        setSentGoals((goals) => { const next = new Set(goals); next.delete(sent); return next; });
        setGoal((value) => value || nextGoal);
      }
    } finally { setSubmitting(false); setPendingGoal(null); }
  };
  const togglePick = (question: QuizQuestion, choiceId: string) => {
    setPicks((before) => {
      const ids = before[question.id] ?? [];
      return { ...before, [question.id]: question.multi
        ? ids.includes(choiceId) ? ids.filter((id) => id !== choiceId) : [...ids, choiceId]
        : [choiceId] };
    });
  };

  useEffect(() => {
    if (!active || learning || autoStarted.current || busy || blocked || tabId === null ||
        state.phase !== 'READY' || !state.guide || !state.outboundConfirmed) return;
    void startWith(DEFAULT_LEARN_GOAL, true);
  }, [active, learning, busy, blocked, tabId, state.phase, state.guide, state.outboundConfirmed]);

  const usedGoals = new Set([...usedLearnGoals(learning), ...sentGoals]);
  const starters = [
    ...(!usedGoals.has(DEFAULT_LEARN_GOAL) ? [{ id: 'core', question: '这篇文章的核心内容' }] : []),
    ...(state.guide?.bubbles ?? []).filter((b) => !usedGoals.has(b.question)),
  ];
  const nextDirections = learning?.status === 'closed' && learning.nextDirections?.length
    ? learning.nextDirections.map((text, i) => ({ id: `dir_${i}`, question: text })) : starters;
  const lastQuiz = learning?.log.findLastIndex((entry) => entry.role === 'quiz') ?? -1;
  const quizRecorded = quiz !== null && lastQuiz >= 0 && JSON.stringify(learning?.log[lastQuiz]?.quiz) === JSON.stringify(quiz);
  const lastQuestion = learning?.log.findLastIndex((entry) => entry.role === 'question') ?? -1;
  const openRecorded = current?.kind === 'open' && lastQuestion >= 0 && learning?.log[lastQuestion]?.text === current.question;
  const quizContent = quiz ? <QuizMessage questions={quiz} picks={picks} disabled={busy || blocked} onPick={togglePick} /> : null;
  const outgoing = pending && pending.at === learning?.log.length ? pending : null;
  const updateKey = `${state.learningHistory?.length ?? 0}:${learning?.goal}:${learning?.log.length ?? 0}:${busy}:${state.busy?.draft.length ?? 0}:${state.busy?.reasoning.length ?? 0}:${outgoing?.text ?? ''}:${pendingGoal ?? ''}`;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return;
    event.preventDefault();
    if (!busy && !blocked && (inRound || closed)) void (inRound ? answer() : startWith(goal));
  };

  return <>
    <Conversation active={active} updateKey={updateKey} followRequest={followRequest}>
      {(state.learningHistory ?? []).map((past, i) => <div className="learn-past" key={i}>
        <p className="learn-divider">先前聊过：{past.goal}</p>
        {past.log.map((entry, j) => <Entry key={`${entry.at}-${j}`} entry={entry} diagrams={diagrams} />)}
      </div>)}
      {learning ? <>
        <p className="learn-divider">{inRound ? '围绕' : '聊过'}：{learning.goal}</p>
        {learning.log.map((entry, i) => <Entry key={`${entry.role}-${entry.at}-${i}`} entry={entry} diagrams={diagrams}
          quizContent={inRound && quizRecorded && i === lastQuiz ? quizContent : undefined} />)}
        {inRound && quiz && !quizRecorded && <article className="msg ai"><div className="said">{quizContent}</div></article>}
        {inRound && current?.kind === 'open' && !openRecorded && <article className="msg ai"><div className="said"><Rich text={current.question} diagrams={false} /></div></article>}
      </> : <article className="msg ai"><div className="said"><p>我会先问一个问题。你可以用自己的话回答，答不上来也可以要提示或讲解。</p>
        {startFailed && !busy && <button type="button" className="secondary" disabled={blocked} onClick={() => void startWith(DEFAULT_LEARN_GOAL, true)}>重新提问</button>}
      </div></article>}
      {learning?.status === 'closed' && <SuggestRow lead="换一个点再来一轮" items={nextDirections} disabled={busy || blocked}
        onPick={(item) => void startWith(item.id === 'core' ? DEFAULT_LEARN_GOAL : item.question)} />}
      {pendingGoal && !inRound && <article className="msg user"><div className="bubble user">{pendingGoal}</div></article>}
      {outgoing && <article className="msg user"><div className="bubble user">{outgoing.text}</div></article>}
      {busy && (state.busy?.draft || state.busy?.reasoning
        ? <Drafting text={state.busy?.draft ?? ''} reasoning={state.busy?.reasoning ?? ''} />
        : <Busy label={inRound && current ? '正在看你的回答' : '正在想问题'} chars={state.busy?.chars ?? 0} />)}
    </Conversation>
    <div className="dock">
      {blocked && <p className="composer-notice" role="status">问 AI 正在回答，结束后可以继续这里的对话。</p>}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); if (!busy && !blocked && (inRound || closed)) void (quiz && inRound ? submitQuiz() : inRound ? answer() : startWith(goal)); }}>
        <ComposerField busy={busy} idleLabel={quiz && inRound ? '提交' : closed ? '开始' : '回答'} onStop={stop}
          submitDisabled={blocked || (!closed && (quiz ? !allAnswered : !current || !draft.trim()))}
          tools={inRound && <Assists tabId={tabId} send={send} resume={!current} only={quiz ? ['explain', 'skip', 'end'] : current ? ['unknown', 'hint', 'explain', 'skip', 'end'] : ['skip', 'end']} disabled={busy || blocked} />}>
          {quiz && inRound ? <p className="composer-selection" role="status">{selectedCount ? `已选 ${selectedCount}/${quiz.length} 题，点击箭头提交` : '在上方选择答案，再点击箭头提交'}</p>
            : <><label className="sr-only" htmlFor={closed ? 'learning-goal' : 'learning-answer'}>{closed ? '自己写一个方向' : '用自己的话回答'}</label>
              <ComposerTextarea id={closed ? 'learning-goal' : 'learning-answer'} rows={2} maxLength={closed ? 200 : 1000}
                value={closed ? goal : draft} readOnly={!closed && !current}
                placeholder={closed ? '想从哪一点聊起？' : current ? '用自己的话说说看…' : inRound ? '点击继续提问，或在更多里结束对话' : startFailed ? '点击重新提问' : 'AI 正在准备第一个问题…'}
                onChange={(event) => closed ? setGoal(event.target.value) : setDraft(event.target.value)} onKeyDown={onKeyDown} />
            </>}
        </ComposerField>
      </form>
    </div>
  </>;
}

const ASSIST_LABEL = { unknown: '我不知道', hint: '提示', explain: '讲解', skip: '跳过', end: '结束' } as const;
function Assists({ tabId, send, only, disabled, resume }: {
  tabId: number | null; send: Send; only: (keyof typeof ASSIST_LABEL)[]; disabled: boolean; resume: boolean;
}) {
  const button = (action: keyof typeof ASSIST_LABEL) => <button type="button" key={action} className="quiet" disabled={disabled}
    onClick={() => tabId !== null && void send(action === 'end' ? { type: 'learnEnd', tabId } : { type: 'learnAssist', tabId, action })}>{resume && action === 'skip' ? '继续提问' : ASSIST_LABEL[action]}</button>;
  const more = only.filter((action) => (!resume && action === 'skip') || action === 'end');
  return <>
    {only.filter((action) => (action !== 'skip' || resume) && action !== 'end').map(button)}
    {more.length > 0 && <details className="assist-more"><summary onClick={(event) => { if (disabled) event.preventDefault(); }} aria-disabled={disabled}>更多</summary>
      <div className="assist-menu">{more.map(button)}</div>
    </details>}
  </>;
}
