import { describe, expect, it } from 'vitest';
import { learnSystem } from '../src/core/prompts/learn';
import { cleanLearn } from '../src/core/validate';

describe('model-visible learning output contract', () => {
  it('describes every action with a schema-valid JSON example even under a custom policy', () => {
    const system = learnSystem('Use brief feedback.', 'mixed', false);
    const examples = system.split('\n').flatMap(line => {
      const match = line.match(/^- mode=(ask|respond|hint|explain|close)[^：]*：(\{.*\})$/);
      if (!match) return [];
      return [{ mode: match[1] as 'ask' | 'respond' | 'hint' | 'explain' | 'close', value: JSON.parse(match[2]!) }];
    });
    expect(examples.map(item => item.value.action)).toEqual([
      'question', 'quiz', 'feedback', 'graded', 'hint', 'explain', 'summary',
    ]);
    for (const { mode, value } of examples) {
      const kind = value.action === 'graded' ? 'quiz' : 'open';
      expect(cleanLearn(value, mode, kind, ['b_0']).ok).toBe(true);
    }
  });

  it('requires both graded continuation fields even when only an open question follows', () => {
    const system = learnSystem('Omit unused JSON keys.', 'mixed', false);
    expect(system).toContain('graded 的 nextQuestion 和 nextQuiz 均为必填字段');
    const line = system.split('\n').find(item => item.startsWith('- mode=respond（选择题）：'))!;
    const example = JSON.parse(line.slice(line.indexOf('{')));
    expect(typeof example.nextQuestion).toBe('string');
    expect(example.nextQuiz).toBeNull();
    expect(cleanLearn(example, 'respond', 'quiz', ['b_0']).ok).toBe(true);
  });

  it('rejects omitted continuation fields instead of silently defaulting them', () => {
    const graded = {
      action: 'graded', analysis: 'The selected option matches the article.', notes: [],
      nextQuestion: 'Which cost was not measured?', nextQuiz: null,
    };
    for (const field of ['nextQuestion', 'nextQuiz']) {
      const omitted: Record<string, unknown> = { ...graded };
      delete omitted[field];
      expect(cleanLearn(omitted, 'respond', 'quiz', ['b_0']).ok).toBe(false);
    }
    expect(cleanLearn(graded, 'respond', 'quiz', ['b_0']).ok).toBe(true);
    expect(cleanLearn({ ...graded, nextQuestion: null }, 'respond', 'quiz', ['b_0']).ok).toBe(true);
  });

  it('never treats a model-supplied network label as verified provenance', () => {
    const result = cleanLearn({
      action: 'feedback', verdict: 'partial', feedback: 'Partly understood.', nextQuestion: null,
      supplement: { text: 'Unverified external claim.', source: 'network' },
    }, 'respond', 'open', ['b_0']);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.action === 'feedback') {
      expect(result.value.supplement?.source).toBe('unverified');
      expect(result.value.supplement?.references).toBeUndefined();
    }
  });
});
