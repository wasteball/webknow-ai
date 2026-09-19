import { describe, expect, it } from 'vitest';

import { bingKeyless, bocha, duckduckgo, firecrawl, searxng, tavily } from '../src/core/search/providers';
import { BUILTIN_SEARCH_PROVIDERS, cleanSearchResults, searchWithProvider } from '../src/core/search/registry';
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

/**
 * 免 Key 供应商。
 *
 * Firecrawl 那条是照**真实响应结构**写的（2026-09-19 实测匿名调用可用，
 * 返回 data.web[]）；Bing / DuckDuckGo 那两条的 fixture 只是按目标页面的
 * 结构写的，不是真实抓取——这台机器连不上外网。所以抓页面那两条证明的是
 * "抽取值不对时会被发现"，不能证明真实页面一定抽得到。
 * 抽不到时返回空数组，由上游如实降级，不会污染正文依据。
 */
describe('免 Key 搜索供应商', () => {
  const htmlResponse = (body: string, status = 200) =>
    (async () => new Response(body, { status, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;

  it('Bing：抽出标题、链接与摘要', async () => {
    const html = `<ol id="b_results">
      <li class="b_algo"><h2><a href="https://example.com/a">配送路径研究综述</a></h2>
        <div class="b_caption"><p>这篇综述比较了三种路径方案。</p></div></li>
      <li class="b_algo"><h2 class="b_topTitle"><a href="https://example.com/b">试点方法说明</a></h2>
        <p>样本与周期如何选择。</p></li>
    </ol>`;
    const results = await bingKeyless.search({
      query: '配送路径', count: 5, signal, config: {}, fetchImpl: htmlResponse(html),
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: '配送路径研究综述',
      url: 'https://example.com/a',
      snippet: '这篇综述比较了三种路径方案。',
    });
    expect(results[1]!.url).toBe('https://example.com/b');
  });

  it('Bing：实体与内嵌标签被还原成纯文本', async () => {
    const html = `<li class="b_algo"><h2><a href="https://example.com/x">A &amp; B <b>加粗</b></a></h2>
      <p>5 &lt; 10 &nbsp;并且 &quot;引用&quot;</p></li>`;
    const results = await bingKeyless.search({
      query: 'q', count: 5, signal, config: {}, fetchImpl: htmlResponse(html),
    });
    expect(results[0]!.title).toBe('A & B 加粗');
    expect(results[0]!.snippet).toBe('5 < 10 并且 "引用"');
  });

  it('Bing：第一个 host 抽不到就换第二个', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      // 只有 www.bing.com 返回带结果的页面，cn.bing.com 返回一个空壳。
      return new Response(String(url).includes('cn.bing.com') ? '<html></html>' : '<li class="b_algo"><h2><a href="https://example.com/ok">换到备用域名</a></h2><p>摘要</p></li>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }) as unknown as typeof fetch;
    const results = await bingKeyless.search({ query: 'q', count: 5, signal, config: {}, fetchImpl });
    expect(seen).toHaveLength(2);
    expect(results[0]!.url).toBe('https://example.com/ok');
  });

  it('Bing：页面结构变了（抽不到）就抛错，交给上游降级', async () => {
    await expect(
      bingKeyless.search({ query: 'q', count: 5, signal, config: {}, fetchImpl: htmlResponse('<html><body>改版了</body></html>') }),
    ).rejects.toThrow(/没有返回可解析的结果/);
  });

  it('DuckDuckGo：跳转链接还原成真实目标，摘要按顺序配对', async () => {
    const html = `<div class="result">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freal&amp;rut=abc">真实结果的标题</a></h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">第一段摘要</a>
      </div>
      <div class="result">
        <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">第二条</a></h2>
        <a class="result__snippet" href="x">第二段摘要</a>
      </div>`;
    const results = await duckduckgo.search({
      query: 'q', count: 5, signal, config: {}, fetchImpl: htmlResponse(html),
    });
    expect(results.map((item) => item.url)).toEqual([
      'https://example.com/real',
      'https://example.org/b',
    ]);
    expect(results[0]!.snippet).toBe('第一段摘要');
    expect(results[1]!.snippet).toBe('第二段摘要');
  });

  it('DuckDuckGo：非 HTML（例如被拦截返回 JSON）抽不到结果', async () => {
    const results = await duckduckgo.search({
      query: 'q', count: 5, signal, config: {}, fetchImpl: htmlResponse('{"error":"blocked"}'),
    });
    expect(results).toEqual([]);
  });

  it('Firecrawl：匿名调用（不带 Authorization），解析 data.web', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = init;
      return new Response(
        JSON.stringify({
          success: true,
          data: { web: [{ url: 'https://example.com/a', title: '标题甲', description: '摘要甲' }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const results = await firecrawl.search({
      query: '测试', count: 3, signal, config: {}, fetchImpl,
    });
    expect(results).toEqual([{ title: '标题甲', url: 'https://example.com/a', snippet: '摘要甲' }]);
    // 关键：不带任何鉴权头，这才是"不用注册、不用 Key"。
    const headers = (captured?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('authorization');
    expect(JSON.parse(String(captured?.body))).toMatchObject({ query: '测试', limit: 3 });
  });

  it('Firecrawl：被限流（非 2xx）时报错，交给上游降级', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })) as unknown as typeof fetch;
    await expect(
      firecrawl.search({ query: 'q', count: 3, signal, config: {}, fetchImpl }),
    ).rejects.toThrow(/匿名额度可能已被限流/);
  });

  it('注册表：免 Key 供应商排在最前，且不需要任何凭证', () => {
    // 可靠优先：结构化的 Firecrawl 第一，抓页面的两个紧随其后互为备份。
    const ids = BUILTIN_SEARCH_PROVIDERS.map((provider) => provider.id);
    expect(ids.slice(0, 3)).toEqual(['firecrawl', 'bing', 'duckduckgo']);
    for (const provider of BUILTIN_SEARCH_PROVIDERS.slice(0, 3)) {
      expect(provider.configFields).toEqual([]);
      expect(provider.hosts({}).length).toBeGreaterThan(0);
    }
    // 自备服务的三个仍在，作为备选。
    expect(ids).toEqual(expect.arrayContaining(['searxng', 'tavily', 'bocha']));
  });

  it('免 Key 供应商经 searchWithProvider 走完整条（含清洗与上限）', async () => {
    const html = `<li class="b_algo"><h2><a href="https://example.com/1">一</a></h2><p>甲</p></li>
      <li class="b_algo"><h2><a href="https://example.com/1">重复链接被去重</a></h2><p>乙</p></li>
      <li class="b_algo"><h2><a href="https://example.com/2">二</a></h2><p>丙</p></li>`;
    const results = await searchWithProvider({
      providerId: 'bing', config: {}, query: 'q', count: 5, signal, fetchImpl: htmlResponse(html),
    });
    expect(results.map((item) => item.url)).toEqual(['https://example.com/1', 'https://example.com/2']);
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
