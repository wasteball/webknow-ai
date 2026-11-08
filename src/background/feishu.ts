import { appError } from '../core/errors';
import { FeishuClient, noteToBlocks, toFeishuAppError, type FeishuSpace } from '../core/feishu/client';
import { buildReadingNote } from '../core/ima/note';
import type { PageSession } from '../core/session';
import { readConfig } from './store';

/**
 * 飞书知识库边界（四期）。App Secret 只在这里读取；保存只由用户点收藏触发：
 * 在默认知识空间顶层新建一篇文档，写入与 ima 同一份阅读笔记。
 */

export async function hasFeishuCredentials(): Promise<boolean> {
  const feishu = (await readConfig()).feishu;
  return Boolean(feishu?.appId?.trim() && feishu.appSecret?.trim());
}

function clientFrom(credentials: { appId?: string; appSecret?: string } | undefined): FeishuClient {
  const appId = credentials?.appId?.trim();
  const appSecret = credentials?.appSecret?.trim();
  if (!appId || !appSecret) {
    throw appError('IMA_FAILED', '还没有配置飞书应用。请到设置里填写 App ID 和 App Secret。', false);
  }
  return new FeishuClient({ credentials: { appId, appSecret } });
}

export async function listFeishuSpaces(credentials?: { appId: string; appSecret: string }): Promise<FeishuSpace[]> {
  try {
    return await clientFrom(credentials ?? (await readConfig()).feishu).listSpaces();
  } catch (error) {
    throw toFeishuAppError(error);
  }
}

export async function saveReadingToFeishu(session: PageSession): Promise<{ spaceName: string }> {
  const config = await readConfig();
  const client = clientFrom(config.feishu);
  const spaceId = config.feishu?.spaceId?.trim();
  if (!spaceId) throw appError('IMA_FAILED', '还没有选择飞书知识库。请到设置里选择。', false);
  const { title, markdown } = buildReadingNote({
    title: session.title, url: session.url, savedAt: Date.now(),
    summary: session.guide?.summary ?? '', bubbles: session.guide?.bubbles ?? [],
    chat: session.chat, learning: session.learning,
  });
  try {
    const { documentId } = await client.createDoc(spaceId, title);
    await client.appendBlocks(documentId, noteToBlocks(markdown));
  } catch (error) {
    throw toFeishuAppError(error);
  }
  return { spaceName: config.feishu?.spaceName?.trim() || '飞书知识库' };
}
