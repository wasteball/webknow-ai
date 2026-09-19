import { appError } from '../core/errors';
import { buildReadingNote } from '../core/ima/note';
import { ImaClient, toImaAppError, type ImaKnowledgeBase } from '../core/ima/client';
import type { PageSession } from '../core/session';
import { readConfig, type Config } from './store';

/**
 * ima 知识库边界（K-ima，FR-046/FR-047）。
 * 凭证只在这里读取；保存只由用户显式命令触发，一次保存 = URL 幂等导入 + 一条阅读笔记。
 */

export async function readImaCredentials(): Promise<{ clientId: string; apiKey: string } | null> {
  const ima = (await readConfig()).ima;
  const clientId = ima?.clientId?.trim();
  const apiKey = ima?.apiKey?.trim();
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey };
}

export async function hasImaCredentials(): Promise<boolean> {
  return (await readImaCredentials()) !== null;
}

function requireClient(config: Config): ImaClient {
  const clientId = config.ima?.clientId?.trim();
  const apiKey = config.ima?.apiKey?.trim();
  if (!clientId || !apiKey) {
    throw appError('IMA_FAILED', '还没有配置知识库凭证。请到设置里填写 Client ID 和 API Key。', false);
  }
  return new ImaClient({ credentials: { clientId, apiKey } });
}

/** 连接测试 / 知识库列表：用给定凭证列出可访问知识库。 */
export async function listImaKnowledgeBases(
  credentials?: { clientId: string; apiKey: string },
): Promise<ImaKnowledgeBase[]> {
  const config = await readConfig();
  const effective = credentials ?? {
    clientId: config.ima?.clientId?.trim() ?? '',
    apiKey: config.ima?.apiKey?.trim() ?? '',
  };
  if (!effective.clientId || !effective.apiKey) {
    throw appError('IMA_FAILED', '还没有配置知识库凭证。请到设置里填写 Client ID 和 API Key。', false);
  }
  try {
    return await new ImaClient({ credentials: effective }).listKnowledgeBases();
  } catch (error) {
    throw toImaAppError(error);
  }
}

/** 一次保存：网页 URL 幂等导入所选知识库 + 一条 Markdown 阅读笔记。 */
export async function saveReadingToIma(session: PageSession): Promise<{ urlSaved: boolean; noteSaved: boolean }> {
  const config = await readConfig();
  const client = requireClient(config);
  const kbId = config.ima?.kbId?.trim();
  if (!kbId) {
    throw appError('IMA_FAILED', '还没有选择默认知识库。请到设置里选择。', false);
  }
  if (!/^https?:\/\//.test(session.url)) {
    throw appError('IMA_FAILED', '这一页没有可保存的公开网址。', false);
  }

  // 两步各自尽力完成、分别上报：一步失败不吞掉另一步的成功。
  let urlSaved = false;
  let urlError: unknown = null;
  try {
    const folderId = await client.resolveRootFolder(kbId);
    await client.importUrls(kbId, folderId, [session.url]);
    urlSaved = true;
  } catch (error) {
    urlError = error;
  }

  let noteSaved = false;
  try {
    await writeNote(client, session);
    noteSaved = true;
  } catch (noteError) {
    if (urlSaved) {
      throw appError('IMA_FAILED', '网页已存入知识库，但笔记没有写成。可以稍后重试一次。', true);
    }
    throw toImaAppError(urlError ?? noteError);
  }
  return { urlSaved, noteSaved };
}

async function writeNote(client: ImaClient, session: PageSession): Promise<void> {
  const { title, markdown } = buildReadingNote({
    title: session.title,
    url: session.url,
    savedAt: Date.now(),
    summary: session.guide?.summary ?? '',
    bubbles: session.guide?.bubbles ?? [],
    chat: session.chat,
    learning: session.learning,
  });
  await client.importDoc(title, markdown);
}
