import type { QuizQuestion } from '../../core/session';
import { RichInline } from './Rich';

/** 当前选择题只在 AI 消息中出现；历史题目由 Entry 只读呈现。 */
export function QuizMessage({ questions, picks, disabled, onPick }: {
  questions: QuizQuestion[];
  picks: Record<string, string[]>;
  disabled: boolean;
  onPick: (question: QuizQuestion, choiceId: string) => void;
}) {
  return <div className="quiz-message">{questions.map((question, index) => (
    <fieldset className="quiz-question" key={question.id}>
      <legend>{questions.length > 1 && `${index + 1}. `}<RichInline text={question.text} />{question.multi && <span className="tag">可多选</span>}</legend>
      {question.choices.map((choice) => <label key={choice.id} className="quiz-option">
        <input type={question.multi ? 'checkbox' : 'radio'} name={`quiz-${question.id}`} checked={(picks[question.id] ?? []).includes(choice.id)}
          disabled={disabled} onChange={() => onPick(question, choice.id)} />
        <span><RichInline text={choice.label} /></span>
      </label>)}
    </fieldset>
  ))}</div>;
}
