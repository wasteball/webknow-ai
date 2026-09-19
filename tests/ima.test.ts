import { describe, expect, it } from 'vitest';

import { ImaClient, toImaAppError } from '../src/core/ima/client';
import { buildReadingNote } from '../src/core/ima/note';

const signal = AbortSignal.timeout(5_000);

function mockFetch(payload: unknown, status = 200) {
  let captured: { url: string; init?: RequestInit } | undefined;
  const impl = (async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as (input: string, init?: RequestInit) => Promise<Response>;
  return {
    impl: impl as unknown as typeof fetch,
    last: () => captured!,
  };
}

const credentials = { clientId: ' cid-1 ', apiKey: ' key-1 ' };

describe('ima 客户端（K-ima）', () => {
  it('凭证双头 + POST JSON；两种业务失败包络都要识别', async () => {
    const ok = mockFetch({ code: 0, data: { info_list: [] } });
    const client = new ImaClient({ credentials, fetchImpl: ok.impl });
    await client.listKnowledgeBases();
    const { url, init } = ok.last();
    expect(url).toBe('https://ima.qq.com/openapi/wiki/v1/search_knowledge_base');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['ima-openapi-clientid']).toBe('cid-1');
    expect(headers['ima-openapi-apikey']).toBe('key-1');

    const envelopeA = mockFetch({ code: 220030, msg: '没有权限' });
    await expect(
      new ImaClient({ credentials, fetchImpl: envelopeA.impl }).listKnowledgeBases(),
    ).rejects.toMatchObject({ code: 'IMA_FAILED', message: expect.stringContaining('220030') });

    const envelopeB = mockFetch({ retcode: 110001, errmsg: 'param is error' });
    await expect(
      new ImaClient({ credentials, fetchImpl: envelopeB.impl }).listKnowledgeBases(),
    ).rejects.toMatchObject({ code: 'IMA_FAILED', message: expect.stringContaining('110001') });
  });

  it('401/403 提示去检查凭证且不重试；import_urls 带知识库与目录 id', async () => {
    const rejected = mockFetch({ code: 401, msg: 'unauthorized' }, 401);
    await expect(
      new ImaClient({ credentials, fetchImpl: rejected.impl }).listKnowledgeBases(),
    ).rejects.toMatchObject({ code: 'IMA_FAILED', message: expect.stringContaining('Client ID'), retryable: false });

    const ok = mockFetch({ code: 0, data: {} });
    const client = new ImaClient({ credentials, fetchImpl: ok.impl });
    await client.importUrls('kb-1', 'folder-1', ['https://a.example.com/x']);
    const body = JSON.parse(String(ok.last().init?.body));
    expect(body).toEqual({
      knowledge_base_id: 'kb-1',
      folder_id: 'folder-1',
      urls: ['https://a.example.com/x'],
    });
  });

  it('import_doc 发 Markdown 笔记并返回 doc_id；根目录从 current_path 解析', async () => {
    const ok = mockFetch({ code: 0, data: { doc_id: 'doc-9' } });
    const client = new ImaClient({ credentials, fetchImpl: ok.impl });
    const docId = await client.importDoc('标题', '# 标题\n正文');
    expect(docId).toBe('doc-9');
    const body = JSON.parse(String(ok.last().init?.body));
    expect(body).toMatchObject({ content_format: 1, title: '标题' });
    expect(ok.last().url).toBe('https://ima.qq.com/openapi/note/v1/import_doc');

    const root = mockFetch({ code: 0, data: { current_path: [{ folder_id: 'root-1', name: 'KB' }] } });
    await expect(new ImaClient({ credentials, fetchImpl: root.impl }).resolveRootFolder('kb-1')).resolves.toBe(
      'root-1',
    );
  });

  it('错误归一化：未知异常变成可重试的 IMA_FAILED', () => {
    const mapped = toImaAppError(new Error('boom'));
    expect(mapped).toMatchObject({ code: 'IMA_FAILED', retryable: true });
    const appLike = { code: 'IMA_FAILED', message: 'x', retryable: false };
    expect(toImaAppError(appLike)).toBe(appLike);
  });
});

describe('阅读笔记构造（K-ima）', () => {
  it('包含标题、链接、摘要、话题方向与问答记录', () => {
    const note = buildReadingNote({
      title: '城市配送试点研究',
      url: 'https://example.com/a',
      savedAt: new Date('2026-09-19T10:30:00').getTime(),
      summary: '新方案把平均处理时间从一百分钟降到八十分钟，但样本只有三个团队。',
      bubbles: [{ id: 'bub_0', question: '为什么样本不能代表其他城市？', kind: 'boundary' }],
      chat: [
        {
          id: 't_1',
          question: '新方案为什么更快？',
          answer: '文章归因于新的路径方案，但无法排除培训影响。',
          source: 'original',
          citations: [],
          unanswered: [],
          references: [],
          at: 0,
        },
      ],
      learning: null,
    });
    expect(note.title).toBe('城市配送试点研究');
    expect(note.markdown).toContain('https://example.com/a');
    expect(note.markdown).toContain('2026-09-19 10:30');
    expect(note.markdown).toContain('## 这篇文章讲了什么');
    expect(note.markdown).toContain('- 为什么样本不能代表其他城市？');
    expect(note.markdown).toContain('**问：新方案为什么更快？**');
  });

  it('学习进行中列出问题；气泡与正文都有截断上限', () => {
    const longQuestion = '问'.repeat(500);
    const note = buildReadingNote({
      title: 'T'.repeat(300),
      url: 'https://example.com/b',
      savedAt: Date.now(),
      summary: '摘要',
      bubbles: [{ id: 'b0', question: longQuestion, kind: 'concept' }],
      chat: [],
      learning: {
        goal: 'g',
        promptVersion: 'v',
        budget: 5,
        used: 1,
        current: null,
        status: 'active',
        log: [{ role: 'question', text: longQuestion, at: 0 }],
      },
    });
    expect(note.title.length).toBeLessThanOrEqual(121);
    expect(note.markdown).not.toContain('问'.repeat(400));
  });
});
