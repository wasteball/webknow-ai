import { describe, expect, it, vi } from 'vitest';

import { LIMITS } from '../src/core/limits';
import { chatJson, createSseReader, parseJsonLoose } from '../src/core/model-call';
import { findProvider } from '../src/core/model-providers';

function sseResponse(chunks: string[], status = 200): typeof fetch {
  const encoder = new TextEncoder();
  return (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
}

function delta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

const base = {
  apiKey: 'test-key',
  provider: findProvider('deepseek'),
  messages: [{ role: 'user' as const, content: 'hi' }],
  signal: new AbortController().signal,
};

describe('createSseReader', () => {
  it('跨 chunk 的半行不会丢失内容', () => {
    const reader = createSseReader();
    const line = delta('{"answer":"你好"}');
    const split = Math.floor(line.length / 2);
    expect(reader.push(line.slice(0, split))).toEqual([]);
    expect(reader.push(line.slice(split))).toEqual(['{"answer":"你好"}']);
  });

  it('忽略 keep-alive 注释与 [DONE]', () => {
    const reader = createSseReader();
    expect(reader.push(': keep-alive\n\n')).toEqual([]);
    expect(reader.push('data: [DONE]\n\n')).toEqual([]);
  });

  it('思考过程单独累计，不混进正文分片', () => {
    const reader = createSseReader();
    const thought = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先看前提' } }] })}\n\n`;
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer":"结论"}', reasoning_content: '。' } }] })}\n\n`;
    expect(reader.push(thought)).toEqual([]);
    expect(reader.reasoning()).toBe('先看前提');
    expect(reader.push(body)).toEqual(['{"answer":"结论"}']);
    expect(reader.reasoning()).toBe('先看前提。');
  });
});

describe('parseJsonLoose', () => {
  it('容忍代码块包裹与前后缀', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('好的，结果如下：{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('完全不是 JSON')).toBeUndefined();
  });

  it('正文中的 mermaid 代码块不被误当成包裹整个 JSON 的围栏', () => {
    const response = JSON.stringify({
      answer: '先说明。\n\n```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```',
      source: 'original',
      citations: ['b_1'],
      unanswered: [],
    });
    expect(parseJsonLoose(response)).toEqual({
      answer: '先说明。\n\n```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```',
      source: 'original',
      citations: ['b_1'],
      unanswered: [],
    });
  });
});

describe('chatJson', () => {
  it('assembles action JSON across SSE events and split transport lines', async () => {
    const first = delta('{"type":"ask_user","question":"哪个');
    const fetchImpl = sseResponse([first.slice(0, 17), first.slice(17), delta('团队？","reason":"ambiguous_entity"}'), 'data: [DONE]\n\n']);
    await expect(chatJson({ ...base, fetchImpl })).resolves.toEqual({ type: 'ask_user', question: '哪个团队？', reason: 'ambiguous_entity' });
  });

  it('rejects length truncation even when preceding action JSON parses', async () => {
    const fetchImpl = sseResponse([delta('{"type":"ask_user","question":"哪个？","reason":"ambiguous_entity"}'),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`]);
    await expect(chatJson({ ...base, fetchImpl })).rejects.toMatchObject({ code: 'BAD_OUTPUT' });
  });

  it('never interprets reasoning-only action JSON as a completed action', async () => {
    const fetchImpl = sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '{"type":"ask_user","question":"哪个？","reason":"ambiguous_entity"}' } }] })}\n\n`]);
    await expect(chatJson({ ...base, fetchImpl })).rejects.toMatchObject({ code: 'BAD_OUTPUT' });
  });

  it('rejects pre-aborted calls even if the transport ignores cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchImpl = vi.fn(sseResponse([delta('{"type":"ask_user","question":"哪个？","reason":"ambiguous_entity"}') ]));
    await expect(chatJson({ ...base, signal: controller.signal, fetchImpl })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects completed action JSON when cancellation happens while reading', async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => new Response(new ReadableStream({
      pull(stream) {
        stream.enqueue(new TextEncoder().encode(delta('{"type":"ask_user","question":"哪个？","reason":"ambiguous_entity"}')));
        controller.abort(); stream.close();
      },
    }))) as typeof fetch;
    await expect(chatJson({ ...base, signal: controller.signal, fetchImpl })).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('does not accept an interrupted stream even after receiving valid JSON', async () => {
    let pulls = 0;
    const fetchImpl = (async () => new Response(new ReadableStream({
      pull(stream) {
        if (pulls++ === 0) stream.enqueue(new TextEncoder().encode(delta('{"type":"ask_user","question":"哪个？","reason":"ambiguous_entity"}')));
        else stream.error(new Error('connection dropped'));
      },
    }))) as typeof fetch;
    await expect(chatJson({ ...base, fetchImpl })).rejects.toMatchObject({ code: 'SERVICE' });
  });

  it('拼接流式分片并返回解析后的 JSON', async () => {
    const fetchImpl = sseResponse([
      delta('{"answer":"原'),
      delta('文依据'),
      delta('"}'),
      'data: [DONE]\n\n',
    ]);
    await expect(chatJson({ ...base, fetchImpl })).resolves.toEqual({ answer: '原文依据' });
  });

  it('把 HTTP 状态映射成产品错误类别', async () => {
    const cases: [number, string][] = [
      [401, 'KEY_INVALID'],
      [402, 'INSUFFICIENT_BALANCE'],
      [429, 'RATE_LIMITED'],
      [500, 'SERVICE'],
      [400, 'UNSUPPORTED_MODEL'],
    ];
    for (const [status, code] of cases) {
      const fetchImpl = (async () => new Response('{}', { status })) as unknown as typeof fetch;
      await expect(chatJson({ ...base, fetchImpl })).rejects.toMatchObject({ code });
    }
  });

  it('取消后抛出 ABORTED，而不是网络错误', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    await expect(chatJson({ ...base, signal: controller.signal, fetchImpl })).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  it('输出被长度上限截断时如实报错，不当作完整结果', async () => {
    const truncated = `data: ${JSON.stringify({
      choices: [{ delta: { content: '{"summary":"被截断的' }, finish_reason: null }],
    })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`;
    const fetchImpl = sseResponse([truncated]);
    await expect(chatJson({ ...base, fetchImpl })).rejects.toMatchObject({ code: 'BAD_OUTPUT' });
    await expect(chatJson({ ...base, fetchImpl })).rejects.toThrowError(/到上限|半截/);
  });

  it('按 A0 实测固定请求体：关闭思考并限定 JSON 输出', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":1}' } }] })}\n\n`, {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await chatJson({ ...base, fetchImpl });
    expect(sent.model).toBe('deepseek-flash');
    expect(sent.stream).toBe(true);
    expect(sent.response_format).toEqual({ type: 'json_object' });
    // 默认思考会占用 max_tokens 预算并让延迟翻倍（2026-09-18 实测）。
    expect(sent.thinking).toEqual({ type: 'disabled' });
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.max_tokens).toBe(LIMITS.maxOutputTokens);
  });

  it('选了极致时打开思考、带上 max，并提高输出上限', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":1}' } }] })}\n\n`, {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await chatJson({ ...base, model: 'deepseek-v4-pro', thinking: 'max', fetchImpl });
    expect(sent.thinking).toEqual({ type: 'enabled' });
    expect(sent.reasoning_effort).toBe('max');
    expect(sent.max_tokens).toBe(LIMITS.maxOutputTokensThinking);
    expect(sent.response_format).toEqual({ type: 'json_object' });
  });

  it('glm-5.2 默认不写思考字段', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":1}' } }] })}\n\n`, {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await chatJson({ ...base, provider: findProvider('zhipu'), model: 'glm-5.2', fetchImpl });
    expect(sent.thinking).toBeUndefined();
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.max_tokens).toBe(LIMITS.maxOutputTokens);
  });

  it('连接测试传入的小上限不会被思考档抬高', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":1}' } }] })}\n\n`, {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await chatJson({ ...base, thinking: 'max', maxTokens: 16, fetchImpl });
    expect(sent.max_tokens).toBe(16);
    expect(sent.reasoning_effort).toBe('max');
  });

  it('输出不是 JSON 时判为无效输出，不猜测修补', async () => {
    const fetchImpl = sseResponse([delta('这是散文，不是 JSON。')]);
    await expect(chatJson({ ...base, fetchImpl })).rejects.toMatchObject({ code: 'BAD_OUTPUT' });
  });

  it('上报生成进度：字符数仍是数字，草稿只含读者可见的正文', async () => {
    const onProgress = vi.fn();
    const fetchImpl = sseResponse([delta(`{"answer":"${'x'.repeat(500)}","citations":["b_5"]}`)]);
    await chatJson({ ...base, fetchImpl, onProgress });
    expect(onProgress).toHaveBeenCalled();
    const last = onProgress.mock.calls.at(-1) as [number, string] | undefined;
    // 计量仍是字符数，不把整段 JSON 拿去记日志（FR-037）。
    expect(last?.[0]).toBeGreaterThanOrEqual(500);
    expect(last?.[1]).toBe('x'.repeat(500));
    expect(last?.[1]).not.toContain('b_5');
  });

  it('回答还在写时，进度草稿跟着已写出的句子变长', async () => {
    const onProgress = vi.fn();
    const fetchImpl = sseResponse([
      delta('{"answer":"原文'),
      delta('依据","citations":["b_5"],"followUps":[{"question":"再问"}]}'),
    ]);
    await chatJson({ ...base, fetchImpl, onProgress });
    const calls = onProgress.mock.calls as [number, string][];
    expect(calls[0]?.[1]).toBe('原文');
    expect(calls.at(-1)?.[1]).toBe('原文依据');
  });

  it('进度里单独带上思考过程，解析结果仍只有正文 JSON', async () => {
    const onProgress = vi.fn();
    const fetchImpl = sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先想' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '清楚' } }] })}\n\n`,
      delta('{"answer":"原文依据"}'),
    ]);
    await expect(chatJson({ ...base, fetchImpl, onProgress })).resolves.toEqual({ answer: '原文依据' });
    const calls = onProgress.mock.calls as [number, string, string][];
    expect(calls.some((call) => call[2] === '先想')).toBe(true);
    expect(calls.at(-1)?.[1]).toBe('原文依据');
    expect(calls.at(-1)?.[2]).toBe('先想清楚');
    expect(calls.every((call) => !String(call[1]).includes('先想'))).toBe(true);
  });
});

/**
 * 失败分类：**不能只看 HTTP 状态**。
 * 下面每一条的响应体都是 2026-09-19 从智谱真实接口抓下来的原样结构。
 */
describe('失败分类按供应商错误码', () => {
  const sseOk = (body: string) =>
    (async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;

  const fail = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

  it('智谱 429 + code 1113 是「余额不足」，不是「太忙」', async () => {
    // 真实响应：{"code":"1113","message":"余额不足或无可用资源包,请充值。"}
    const failure = chatJson({
      ...base,
      provider: findProvider('zhipu'),
      fetchImpl: fail(429, { code: '1113', message: '余额不足或无可用资源包,请充值。' }),
    });
    await expect(failure).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    // 文案要点名是哪家，并且给出可执行的下一步（去充值），不是"等一会儿"。
    await expect(failure).rejects.toThrowError(/智谱.*余额不够.*充值/);
  });

  it('DeepSeek 的 429 仍是「限流」——同样状态码，含义不同', async () => {
    const failure = chatJson({
      ...base,
      provider: findProvider('deepseek'),
      fetchImpl: fail(429, { error: { message: 'Rate limit reached' } }),
    });
    await expect(failure).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(failure).rejects.toThrowError(/太忙/);
  });

  it('余额字样兜底：码表变了也不会误报成限流', async () => {
    const failure = chatJson({
      ...base,
      provider: findProvider('zhipu'),
      fetchImpl: fail(429, { code: '9999', message: 'Account balance is insufficient.' }),
    });
    await expect(failure).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('智谱 401 与 400+1211 各自给出可执行的下一步', async () => {
    // 真实响应：{"code":"1000","message":"身份验证失败。"}
    await expect(
      chatJson({ ...base, provider: findProvider('zhipu'), fetchImpl: fail(401, { code: '1000', message: '身份验证失败。' }) }),
    ).rejects.toMatchObject({ code: 'KEY_INVALID' });
    // 真实响应：{"code":"1211","message":"模型不存在，请检查模型代码。"}
    const badModel = chatJson({
      ...base,
      provider: findProvider('zhipu'),
      fetchImpl: fail(400, { code: '1211', message: '模型不存在，请检查模型代码。' }),
    });
    await expect(badModel).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL' });
    await expect(badModel).rejects.toThrowError(/换一个|手动填写/);
  });

  it('读不出正文时退回按状态码分类，不因此报错', async () => {
    const notJson = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch;
    await expect(
      chatJson({ ...base, provider: findProvider('deepseek'), fetchImpl: notJson }),
    ).rejects.toMatchObject({ code: 'SERVICE' });
  });

  it('成功路径不读正文：正常流式结果照常返回', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"{\\"answer\\":1}"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
    await expect(chatJson({ ...base, fetchImpl: sseOk(body) })).resolves.toEqual({ answer: 1 });
  });
});
