/**
 * 对话连续（二期）：屏幕和存储上的对话一条不删；发给模型的历史在这里压缩。
 *
 * 最近 RECENT 轮原样带上；更早的每轮浓缩成“问题 + 回答开头”，按时间顺序全部保留，
 * 所以“回到第一个问题”“刚才那个”仍接得上。总字数有上限，超出时从最早的浓缩条目里继续缩短，
 * 但问题本身始终保留。
 *
 * ponytail: 浓缩是本地截取，不调用模型（不额外花钱、不多一个失败点）。
 * 早期回答细节靠截取保不全；真不够用时再加“模型写摘要”的增量浓缩。
 */

export const HISTORY = {
  recent: 8,
  earlierAnswerChars: 160,
  budgetChars: 12_000,
} as const;

export type Exchange = { question: string; answer: string };

export function condenseHistory<T extends Exchange>(turns: readonly T[], limits: { recent: number; earlierAnswerChars: number; budgetChars: number } = HISTORY): T[] {
  const cut = Math.max(0, turns.length - limits.recent);
  const recent = turns.slice(cut);
  let earlier = turns.slice(0, cut).map((turn) => ({ ...turn, answer: clip(turn.answer, limits.earlierAnswerChars), condensed: true }));
  const size = () => [...earlier, ...recent].reduce((sum, turn) => sum + turn.question.length + turn.answer.length, 0);
  // 超预算：早期回答逐步缩到只剩问题；问题本身不丢。
  for (let keep = limits.earlierAnswerChars / 2; size() > limits.budgetChars && keep >= 1; keep = Math.floor(keep / 2)) {
    earlier = earlier.map((turn) => ({ ...turn, answer: clip(turn.answer, keep) }));
  }
  if (size() > limits.budgetChars) earlier = earlier.map((turn) => ({ ...turn, answer: '' }));
  return [...earlier, ...recent] as T[];
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}
