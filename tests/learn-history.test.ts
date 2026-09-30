import { describe, expect, it } from 'vitest';
import { archiveLearning } from '../src/core/learn-policy';
import type { LearningState } from '../src/core/session';

describe('继续新的方向不会丢掉先前对话', () => {
  it('把已结束段留在历史，不复制策略和答案钥匙', () => {
    const previous: LearningState = { goal: '旧方向', promptVersion: '1', policy: '策略', used: 1,
      status: 'closed', current: null, log: [{ role: 'summary', text: '先前小结', at: 1 }] };
    expect(archiveLearning(previous, [])).toEqual([{ goal: '旧方向', log: previous.log }]);
  });
  it('不存在或没有内容的段不进入历史', () => {
    expect(archiveLearning(null, [])).toEqual([]);
    expect(archiveLearning({ goal: '方向', promptVersion: '1', used: 0, status: 'closed', current: null, log: [] }, [])).toEqual([]);
  });
});
