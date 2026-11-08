import type { ReactNode } from 'react';
import type { LearnEntry } from '../../core/session';
import { Thinking } from './bits';
import { Rich, RichInline } from './Rich';
import { SearchSources } from './SearchSources';

export function LearningEntry({ entry, diagrams, quizContent }: { entry: LearnEntry; diagrams: boolean; quizContent?: ReactNode }) {
  if (entry.role === 'skip' || (entry.role === 'note' && !entry.supplement)) {
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
        {entry.supplement && (
          <aside className="supplement">
            <span className="tag">补充说明{entry.supplement.source === 'network' ? '（联网资料）' : entry.supplement.source === 'unverified' ? '（未核验）' : ''}</span>
            <Rich text={entry.supplement.text} diagrams={diagrams} />
            <SearchSources references={entry.supplement.references ?? []} research={entry.supplement.research} />
          </aside>
        )}
        {entry.role === 'question' && <div className="ask-now"><Rich text={entry.text} diagrams={false} pictures={false} /></div>}
        {entry.role === 'quiz' && (quizContent ?? <QuizEntryView entry={entry} />)}
        {/* 导师不打分：判定、对几题、掌握标签仍随记录保存，但只用说话的方式表达。 */}
        {entry.role === 'feedback' && <Rich text={entry.text} diagrams={diagrams} />}
        {entry.role === 'hint' && (
          <>
            <span className="tag">提示</span>
            <Rich text={entry.text} diagrams={false} pictures={false} />
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
