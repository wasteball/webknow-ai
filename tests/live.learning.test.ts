import { describe, expect, it } from 'vitest';

import { chatJson } from '../src/core/model-call';
import { findProvider } from '../src/core/model-providers';
import { learnMessages, type LearnOutput } from '../src/core/prompts/learn';
import type { CurrentRound } from '../src/core/session';
import { cleanLearn } from '../src/core/validate';

// Explicit key opt-in: one request per selected sample and provider, no retries.
const blocks = [
  { id: 'b_0', role: 'paragraph', content: '配送试点观察三个团队四周。新方案平均处理时间为八十分钟，原方案为一百分钟。' },
  { id: 'b_1', role: 'paragraph', content: '三个团队都已接受工具培训。结果只适用于这个试点，不能直接外推到其他城市或更长周期。' },
  { id: 'b_2', role: 'paragraph', content: '试点没有记录燃油和培训成本，不能据处理时间推断总费用下降。' },
];
const blockIds = blocks.map(block => block.id);
const open: CurrentRound = { kind: 'open', question: '试点结果为什么不能直接推广到其他城市？', hintUsed: false };
const quiz: CurrentRound = {
  kind: 'quiz',
  questions: [{ id: 'q1', text: '哪个说法符合试点范围？', multi: false,
    choices: [{ id: 'A', label: '只观察了三个经过培训的团队' }, { id: 'B', label: '已经证明所有城市都会受益' }] }],
  answerKey: [{ questionId: 'q1', answer: ['A'], why: '原文只报告三个经过培训的团队。' }],
};
type Input = Parameters<typeof learnMessages>[0];
const cases: { name: string; input: Partial<Input>; actions: LearnOutput['action'][] }[] = [
  { name: 'open-question', input: { mode: 'ask', style: 'open', current: null, round: 0 }, actions: ['question'] },
  { name: 'quiz-question', input: { mode: 'ask', style: 'quiz', current: null, round: 0 }, actions: ['quiz'] },
  { name: 'misconception-feedback', input: { mode: 'respond', userAnswer: '这已经证明所有城市每天都能至少节约百分之二十的处理时间。' }, actions: ['feedback', 'explain'] },
  { name: 'quiz-feedback', input: { mode: 'respond', current: quiz, userAnswers: [{ questionId: 'q1', choiceIds: ['A'] }] }, actions: ['graded'] },
  { name: 'quiz-feedback-wrong', input: { mode: 'respond', current: quiz, userAnswers: [{ questionId: 'q1', choiceIds: ['B'] }] }, actions: ['graded'] },
  { name: 'quiz-feedback-after-history', input: { mode: 'respond', current: quiz, round: 2,
      userAnswers: [{ questionId: 'q1', choiceIds: ['A'] }], history: [{
        question: '能据处理时间推断总费用下降吗？', answer: '不一定。', verdict: 'partial', hintUsed: false,
        target: { blockIds: ['b_2'], focus: '费用推断' }, mastery: 'basic',
      }],
    }, actions: ['graded'] },
  { name: 'hint', input: { mode: 'hint' }, actions: ['hint'] },
  { name: 'stable-background', input: { mode: 'explain', userAnswer: '请讲解，尤其是样本和外推是什么意思？' }, actions: ['explain'] },
  { name: 'unverified-current-fact', input: {
      mode: 'explain', userAnswer: '上海今天是否也已经采用该方案，并证实了相同效果？',
      supplementalContext: { source: 'unverified', text: '本轮未联网核验上海今天是否采用该方案及其实际效果，文章也未提供这些信息。' },
    }, actions: ['explain'] },
  { name: 'limited-summary', input: { mode: 'close', history: [{
      question: open.question, answer: '只试了三个经过培训的团队，观察了四周，不能直接推广。',
      verdict: 'correct', hintUsed: false, target: { blockIds: ['b_1'], focus: '适用范围' }, mastery: 'independent',
    }] }, actions: ['summary'] },
];

for (const id of ['deepseek', 'zhipu'] as const) {
  const key = process.env[id === 'deepseek' ? 'DEEPSEEK_KEY' : 'ZHIPU_KEY'] ?? '';
  const live = key ? describe : describe.skip;
  const provider = findProvider(id);
  live(`${id} live learning contract`, () => {
    it.each(cases)('$name', { timeout: 90_000 }, async sample => {
      const input: Input = {
        mode: 'ask', title: '配送试点的结果与边界', contextJson: JSON.stringify(blocks),
        disclosure: '只读取给定的三段正文，不含网络资料。', goal: '理解试点结论、适用范围和未验证部分',
        round: 1, history: [], current: open, diagrams: false, ...sample.input,
      };
      const started = Date.now();
      const raw = await chatJson({
        apiKey: key, provider, thinking: 'off', messages: learnMessages(input),
        signal: AbortSignal.timeout(60_000), maxTokens: 1_200,
      });
      const cleaned = cleanLearn(raw, input.mode, input.current?.kind ?? 'open', blockIds);
      process.stdout.write(`[live-learn] ${JSON.stringify({
        provider: id, model: provider.defaultModel, sample: sample.name, ms: Date.now() - started,
        result: cleaned.ok ? cleaned.value : { error: cleaned.error.code, output: raw },
      })}\n`);
      expect(cleaned.ok, `${id}/${sample.name}: learning contract rejected`).toBe(true);
      if (!cleaned.ok) return;
      expect(sample.actions.includes(cleaned.value.action)).toBe(true);
      const supplement = (raw as { supplement?: { source?: string } } | null)?.supplement;
      expect(supplement?.source === 'network', 'model cannot own network provenance').toBe(false);
      if (cleaned.value.action === 'question') {
        expect((cleaned.value.question.match(/[?？]/g) ?? []).length).toBe(1);
      }
      if (cleaned.value.action === 'quiz') expect(cleaned.value.questions.length).toBe(1);
    });
  });
}
