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
