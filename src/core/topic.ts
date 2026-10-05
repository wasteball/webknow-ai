const TOPIC_SWITCH = /^(?:换(?:个|一个)?(?:主题|话题|问题)|先聊(?:聊)?|另一个(?:主题|话题|问题)|换到(?:另一个)?(?:主题|话题|问题))/;

/** Only explicit low-risk wording starts a new context segment. */
export function startsNewTopic(question: string): boolean {
  return TOPIC_SWITCH.test(normalizeQuestion(question));
}

/** Normalize punctuation/spacing for history and follow-up de-duplication. */
export function normalizeQuestion(question: string): string {
  return question
    .trim()
    .toLocaleLowerCase()
    .replace(/[？?。.!！,，、；;：:]/g, '')
    .replace(/\s+/g, '');
}

export function topicHistory<T extends { topicId?: string }>(items: T[], topicId: string, legacyTopic = false): T[] {
  return items.filter((item) => item.topicId === topicId || (legacyTopic && !item.topicId));
}

export function hasAskedQuestion(questions: readonly string[], question: string): boolean {
  const key = normalizeQuestion(question);
  return Boolean(key) && questions.some((item) => normalizeQuestion(item) === key);
}

export function newTopicId(): string {
  return `topic_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
