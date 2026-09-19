/**
 * 对话输入框的提交约定：Enter 发送，Shift+Enter 换行。
 * 中文输入法选词时的 Enter（isComposing / keyCode 229）不能当成发送，
 * 否则刚组完词，句子就被交出去了。
 */
export function shouldSubmitComposer(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  return event.key === 'Enter' && !event.shiftKey;
}
