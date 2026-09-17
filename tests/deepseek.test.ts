import { describe, expect, it, vi } from 'vitest';

import { chatJson, createSseReader, parseJsonLoose } from '../src/core/deepseek';

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
});

describe('parseJsonLoose', () => {
  it('容忍代码块包裹与前后缀', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('好的，结果如下：{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('完全不是 JSON')).toBeUndefined();
  });
});

describe('chatJson', () => {
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

  it('输出不是 JSON 时判为无效输出，不猜测修补', async () => {
    const fetchImpl = sseResponse([delta('这是散文，不是 JSON。')]);
    await expect(chatJson({ ...base, fetchImpl })).rejects.toMatchObject({ code: 'BAD_OUTPUT' });
  });

  it('上报生成进度且不包含正文内容', async () => {
    const onProgress = vi.fn();
    const fetchImpl = sseResponse([delta(`{"answer":"${'x'.repeat(500)}"}`)]);
    await chatJson({ ...base, fetchImpl, onProgress });
    expect(onProgress).toHaveBeenCalled();
    // 进度只回报字符数，不携带正文（FR-037）。
    expect(onProgress.mock.calls.at(-1)?.[0]).toBeGreaterThanOrEqual(500);
  });
});
