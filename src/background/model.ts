import { chatJson, type Message } from '../core/deepseek';
import { appError } from '../core/errors';
import { LIMITS } from '../core/limits';
import { readApiKey } from './store';

/**
 * 唯一允许的模型网络边界（FR-032）。
 * Key 在这里读取并直接用于请求头，不经过界面、提示词、会话数据、日志或诊断。
 */

const TEST_MESSAGES: Message[] = [
  { role: 'system', content: '你是连接测试端点。只返回 JSON。' },
  { role: 'user', content: '返回 {"ok":true}' },
];

export async function callModel(
  messages: Message[],
  signal: AbortSignal,
  onProgress: (chars: number) => void,
): Promise<unknown> {
  const apiKey = await readApiKey();
  if (!apiKey) {
    throw appError('NO_KEY', '还没有配置 DeepSeek Key。请在设置中填写自己的 Key 后再开始。', false);
  }
  return chatJson({ apiKey, messages, signal, onProgress, maxTokens: LIMITS.maxOutputTokens });
}

/** 连接测试：固定最小请求，不发送网页正文（FR-020）。 */
export async function testConnection(key: string): Promise<void> {
  await chatJson({
    apiKey: key.trim(),
    messages: TEST_MESSAGES,
    signal: AbortSignal.timeout(20_000),
    maxTokens: 16,
  });
}
