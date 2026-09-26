export type SuggestItem = { id: string; question: string };

/**
 * 开场卡片点一张就收起。答完后优先用这一轮的联想；
 * 模型没给联想时，把还没问过的开场问题留在回答下面，避免对话断掉。
 * 请求还没写回时先把上一排藏起来，但不能把新的一排也藏掉。
 */
export function visibleSuggestions(input: {
  chatLength: number;
  busy: boolean;
  hiding: boolean;
  hiddenAtTurns: number;
  openers: SuggestItem[];
  followUps: SuggestItem[];
  askedQuestions: string[];
}): { openers: SuggestItem[]; next: SuggestItem[]; nextFrom: 'follow' | 'opener' | 'none' } {
  const concealed = input.hiding && input.chatLength === input.hiddenAtTurns;
  if (input.busy || concealed) return { openers: [], next: [], nextFrom: 'none' };
  if (input.chatLength === 0) return { openers: input.openers, next: [], nextFrom: 'none' };
  if (input.followUps.length) return { openers: [], next: input.followUps, nextFrom: 'follow' };
  const asked = new Set(input.askedQuestions);
  const leftover = input.openers.filter((item) => !asked.has(item.question));
  return { openers: [], next: leftover, nextFrom: leftover.length ? 'opener' : 'none' };
}
