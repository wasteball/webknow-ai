import { describe, expect, it } from 'vitest';

import { shouldSubmitComposer } from '../src/sidepanel/composer';

/**
 * 生产代码里哪条分支错了会让本文件失败：
 * - Enter 不再提交（用户按回车没反应）
 * - Shift+Enter 也被当成提交（没法换行）
 * - 中文输入法选词的 Enter / keyCode 229 被当成提交（刚组完词消息就发出去）
 */
describe('shouldSubmitComposer', () => {
  it('Enter 提交，Shift+Enter 换行', () => {
    expect(shouldSubmitComposer({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(shouldSubmitComposer({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldSubmitComposer({ key: 'a', shiftKey: false })).toBe(false);
  });

  it('输入法组词中的 Enter 不提交', () => {
    expect(shouldSubmitComposer({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitComposer({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
  });
});
