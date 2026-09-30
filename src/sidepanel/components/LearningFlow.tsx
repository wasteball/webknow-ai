import { useEffect, useState, type KeyboardEvent } from 'react';

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
  const signature = current?.kind === 'open' ? current.question : JSON.stringify(quiz ?? []);
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
    setSubmitting(true);
    setFollowRequest((n) => n + 1);
    try { await send({ type: 'learnAnswer', tabId, text: '（选择题作答）', choices }); }
    finally { setSubmitting(false); }
  };
  const startWith = async (nextGoal: string) => {
    if (tabId === null || busy || blocked) return;
    const sent = nextGoal.trim() || DEFAULT_LEARN_GOAL;
    setSentGoals((goals) => new Set(goals).add(sent));
    setPendingGoal(sent);
    setGoal('');
    setSubmitting(true);
    setFollowRequest((n) => n + 1);
    try {
      const reply = await send({ type: 'learnStart', tabId, goal: sent });
      if (!reply?.ok) {
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
    if (!busy && !blocked) void (inRound ? answer() : startWith(goal));
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
      </> : <article className="msg ai"><div className="said"><p>它来问你，你来答。答不上来就说不知道，它会先给提示。</p>
        <SuggestRow lead="先选要弄懂的那一点" items={starters} disabled={busy || blocked}
          onPick={(item) => void startWith(item.id === 'core' ? DEFAULT_LEARN_GOAL : item.question)} />
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
      <form className="composer" onSubmit={(event) => { event.preventDefault(); if (!busy && !blocked) void (quiz && inRound ? submitQuiz() : inRound ? answer() : startWith(goal)); }}>
        <ComposerField busy={busy} idleLabel={quiz && inRound ? '提交' : inRound ? '回答' : '开始'} onStop={stop}
          submitDisabled={blocked || (inRound ? quiz ? !allAnswered : !current || !draft.trim() : false)}
          tools={inRound && <Assists tabId={tabId} send={send} resume={!current} only={quiz ? ['explain', 'skip', 'end'] : current ? ['unknown', 'hint', 'explain', 'skip', 'end'] : ['skip', 'end']} disabled={busy || blocked} />}>
          {quiz && inRound ? <p className="composer-selection" role="status">{selectedCount ? `已选 ${selectedCount}/${quiz.length} 题，点击箭头提交` : '在上方选择答案，再点击箭头提交'}</p>
            : <><label className="sr-only" htmlFor={inRound ? 'learning-answer' : 'learning-goal'}>{inRound ? '用自己的话回答' : '自己写一个方向'}</label>
              <ComposerTextarea id={inRound ? 'learning-answer' : 'learning-goal'} rows={2} maxLength={inRound ? 1000 : 200}
                value={inRound ? draft : goal} readOnly={inRound && !current}
                placeholder={inRound ? current ? '用自己的话说说看…' : '点击继续提问，或在更多里结束对话' : '想从哪一点聊起？'}
                onChange={(event) => inRound ? setDraft(event.target.value) : setGoal(event.target.value)} onKeyDown={onKeyDown} />
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
