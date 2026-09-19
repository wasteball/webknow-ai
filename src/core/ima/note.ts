import type { Bubble, ChatTurn, LearningState } from '../session';
import { LIMITS } from '../limits';

/**
 * 阅读笔记构造器（K-ima，FR-047）：把当前会话的阅读成果组织成一条 Markdown 笔记，
 * 发给腾讯 ima。纯函数、可单测。所有段落都有截断上限，笔记不会无限膨胀。
 */

export type ReadingNoteInput = {
  title: string;
  url: string;
  savedAt: number;
  summary: string;
  bubbles: Bubble[];
  chat: ChatTurn[];
  learning: LearningState | null;
};

function line(value: string): string {
  return value.replaceAll('\r', '').trim();
}

function sectionHeading(text: string, maxChars: number): string {
  const clean = line(text);
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

export function buildReadingNote(input: ReadingNoteInput): { title: string; markdown: string } {
  const savedAt = new Date(input.savedAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${savedAt.getFullYear()}-${pad(savedAt.getMonth() + 1)}-${pad(savedAt.getDate())} ${pad(savedAt.getHours())}:${pad(savedAt.getMinutes())}`;
  const title = sectionHeading(input.title || '网页阅读笔记', 120);

  const parts: string[] = [];
  parts.push(`# ${title}`);
  parts.push(`> 原文：${input.url}`);
  parts.push(`> 由 webknow-ai 保存于 ${stamp}`);

  parts.push('\n## 这篇文章讲了什么');
  parts.push(sectionHeading(input.summary, 2_000));

  if (input.bubbles.length) {
    parts.push('\n## 可以继续探索的方向');
    for (const bubble of input.bubbles.slice(0, LIMITS.maxBubbles)) {
      parts.push(`- ${sectionHeading(bubble.question, LIMITS.bubbleQuestionMaxChars * 2)}`);
    }
  }

  const recentChat = input.chat.slice(-3);
  if (recentChat.length) {
    parts.push('\n## 问答记录（最近几轮）');
    for (const turn of recentChat) {
      parts.push(`**问：${sectionHeading(turn.question, 200)}**`);
      parts.push(sectionHeading(turn.answer, 800));
      parts.push('');
    }
  }

  if (input.learning && input.learning.log.length) {
    parts.push('\n## 学习小结');
    const closed = input.learning.log.find((entry) => entry.role === 'summary');
    if (closed) {
      parts.push(sectionHeading(closed.text, 1_200));
    } else {
      const questions = input.learning.log
        .filter((entry) => entry.role === 'question' || entry.role === 'quiz')
        .slice(-LIMITS.learningBudget);
      for (const question of questions) {
        parts.push(`- ${sectionHeading(question.text.split('\n')[0] ?? '', 200)}`);
      }
    }
  }

  return { title, markdown: parts.join('\n') };
}
