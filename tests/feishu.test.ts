import { describe, expect, it, vi } from 'vitest';
import { FeishuClient, noteToBlocks } from '../src/core/feishu/client';

const ok = (data: Record<string, unknown>) => new Response(JSON.stringify({ code: 0, msg: 'ok', ...data }), { status: 200 });

describe('飞书客户端', () => {
  it('取一次访问凭证并复用；建文档后按 50 个一批追加块', async () => {
    const calls: { url: string; body?: unknown; auth?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization });
      if (url.endsWith('/tenant_access_token/internal')) return ok({ tenant_access_token: 't-abc', expire: 7200 });
      if (url.includes('/wiki/v2/spaces/sp1/nodes')) return ok({ data: { node: { obj_token: 'doc1', node_token: 'wik1' } } });
      return ok({ data: {} });
    });
    const client = new FeishuClient({ credentials: { appId: 'cli_x', appSecret: 's' }, fetchImpl });
    const { documentId } = await client.createDoc('sp1', '标题');
    await client.appendBlocks(documentId, Array.from({ length: 120 }, () => ({ block_type: 2, text: {} })));
    expect(calls.filter((c) => c.url.endsWith('/internal'))).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ app_id: 'cli_x', app_secret: 's' });
    expect(calls[1]!.body).toEqual({ obj_type: 'docx', node_type: 'origin', title: '标题' });
    const writes = calls.filter((c) => c.url.includes('/docx/v1/documents/doc1/blocks/doc1/children'));
    expect(writes.map((c) => (c.body as { children: unknown[] }).children.length)).toEqual([50, 50, 20]);
    expect(writes.every((c) => c.auth === 'Bearer t-abc')).toBe(true);
  });

  it('列知识空间会翻页', async () => {
    let page = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/internal')) return ok({ tenant_access_token: 't', expire: 7200 });
      page += 1;
      return page === 1
        ? ok({ data: { items: [{ space_id: 's1', name: '读书笔记' }], has_more: true, page_token: 'p2' } })
        : ok({ data: { items: [{ space_id: 's2', name: '工作' }], has_more: false } });
    });
    const spaces = await new FeishuClient({ credentials: { appId: 'a', appSecret: 'b' }, fetchImpl }).listSpaces();
    expect(spaces).toEqual([{ id: 's1', name: '读书笔记' }, { id: 's2', name: '工作' }]);
  });

  it('没有知识库权限时说人话：把应用加为成员', async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('/internal')
      ? ok({ tenant_access_token: 't', expire: 7200 })
      : new Response(JSON.stringify({ code: 131006, msg: 'permission denied' }), { status: 400 }));
    await expect(new FeishuClient({ credentials: { appId: 'a', appSecret: 'b' }, fetchImpl }).createDoc('s', 't'))
      .rejects.toMatchObject({ message: expect.stringContaining('加为这个知识库的成员') });
  });
});

describe('阅读笔记 → 飞书文档块', () => {
  it('标题、引用、列表、加粗问题、段落各对各的块类型；一级标题不重复', () => {
    const blocks = noteToBlocks('# 标题\n> 原文：https://x\n\n## 这篇文章讲了什么\n摘要一段\n- 方向一\n**问：为什么？**\n因为。');
    expect(blocks.map((b) => b.block_type)).toEqual([15, 4, 2, 12, 2, 2]);
    expect(JSON.stringify(blocks[4])).toContain('"bold":true');
  });
});

describe('飞书块：原文与笔记的分隔', () => {
  it('### 转三级标题、--- 转分割线、正文中间的一级标题保留', async () => {
    const { noteToBlocks } = await import('../src/core/feishu/client');
    const blocks = noteToBlocks('# 标题\n## 原文\n### 小节\n段落\n---\n# 我的阅读笔记\n## 这篇文章讲了什么');
    expect(blocks.map(block => block.block_type)).toEqual([4, 5, 2, 22, 3, 4]);
  });
});

