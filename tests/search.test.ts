import { describe, expect, it } from 'vitest';

import { searxng, tavily, bocha } from '../src/core/search/providers';
import { cleanSearchResults, searchWithProvider } from '../src/core/search/registry';
import { cleanAnswer } from '../src/core/validate';
import type { EvidenceBlock } from '../src/core/blocks';

function mockFetch(payload: unknown, status = 200) {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

const signal = AbortSignal.timeout(5_000);

describe('搜索供应商解析（产品化改造 F3）', () => {
  it('SearXNG：解析 results 数组，缺实例地址时报错', async () => {
    const results = await searxng.search({
      query: '测试',
      count: 3,
      signal,
      config: { baseUrl: 'https://searx.example.com/' },
      fetchImpl: mockFetch({
        results: [
          { title: 'T1', url: 'https://a.example.com/x', content: '内容一' },
          { title: 'T2', url: 'https://b.example.com/y', content: '内容二' },
        ],
      }),
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: 'T1', url: 'https://a.example.com/x', snippet: '内容一' });

    await expect(
      searxng.search({ query: '测试', count: 3, signal, config: {}, fetchImpl: mockFetch({}) }),
    ).rejects.toThrow('缺少实例地址');
  });

  it('Tavily：带 Bearer 头与 max_results', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://t.example.com', content: 'C' }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const results = await tavily.search({
      query: '测试',
      count: 4,
      signal,
      config: { apiKey: 'tvly-key' },
      fetchImpl,
    });
    expect(results).toHaveLength(1);
    const body = JSON.parse(String(captured?.body));
    expect(body).toMatchObject({ query: '测试', max_results: 4 });
    expect((captured?.headers as Record<string, string>).Authorization).toBe('Bearer tvly-key');
  });

  it('博查：读取 data.webPages.value，summary 优先于 snippet', async () => {
    const results = await bocha.search({
      query: '测试',
      count: 3,
      signal,
      config: { apiKey: 'sk-b' },
      fetchImpl: mockFetch({
        data: {
          webPages: {
            value: [
              { name: 'N1', url: 'https://b.example.com/1', summary: '摘要', snippet: '片段' },
              { name: 'N2', url: 'https://b.example.com/2', snippet: '只有片段' },
            ],
          },
        },
      }),
    });
    expect(results[0]?.snippet).toBe('摘要');
    expect(results[1]?.snippet).toBe('只有片段');
  });

  it('searchWithProvider：HTTP 失败归一为 SEARCH_FAILED，不把异常细节泄露给界面', async () => {
    const outcome = searchWithProvider({
      providerId: 'tavily',
      config: { apiKey: 'bad' },
      query: '测试',
      count: 3,
      signal,
      fetchImpl: mockFetch({ error: 'x' }, 401),
    });
    await expect(outcome).rejects.toMatchObject({ code: 'SEARCH_FAILED' });
    await expect(
      searchWithProvider({ providerId: 'nope', config: {}, query: 'x', count: 3, signal }),
    ).rejects.toMatchObject({ code: 'SEARCH_FAILED' });
  });

  it('cleanSearchResults：去重、过滤非 http、限量', () => {
    const cleaned = cleanSearchResults(
      [
        { title: 'A'.repeat(300), url: 'https://a.example.com', snippet: 's'.repeat(600) },
        { title: 'A2', url: 'https://a.example.com', snippet: '重复' },
        { title: 'B', url: 'javascript:alert(1)', snippet: '危险' },
        { title: 'C', url: 'https://c.example.com', snippet: 'ok' },
      ],
      5,
    );
    expect(cleaned).toHaveLength(2);
    expect(cleaned[0]?.title.length).toBeLessThanOrEqual(200);
    expect(cleaned[0]?.snippet.length).toBeLessThanOrEqual(500);
  });
});

describe('回答 references 校验（F3）', () => {
  const blocks: EvidenceBlock[] = [
    {
      id: 'b_0',
      role: 'paragraph',
      content: '正文',
      headingPath: [],
      anchor: {
        sessionAnchorId: 'a',
        selector: 'p',
        exact: '正文',
        prefix: '',
        suffix: '',
        headingPath: [],
        fingerprint: 'f',
      },
    },
  ];

  it('references 只保留注入过的 URL，其余丢弃', () => {
    const clean = cleanAnswer(
      {
        answer: '回答',
        source: 'original',
        citations: ['b_0'],
        unanswered: [],
        references: ['https://a.example.com/x', 'https://evil.example.com/fake'],
      },
      blocks,
      [{ title: 'T', url: 'https://a.example.com/x', snippet: 'S' }],
    );
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.value.references).toEqual(['https://a.example.com/x']);
  });

  it('没有正文引用但主要依据来自网络资料时，不强行降级为 unknown', () => {
    const clean = cleanAnswer(
      { answer: '回答', source: 'original', citations: [], unanswered: [], references: [] },
      blocks,
      [{ title: 'T', url: 'https://a.example.com/x', snippet: 'S' }],
    );
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.value.source).toBe('original');
  });
});
