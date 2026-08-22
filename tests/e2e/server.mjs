import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const requests = [];

function json(response, body, status = 200) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
  });
  response.end(JSON.stringify(body));
}

function extract(content, label) {
  const match = content.match(
    new RegExp(`(WKA_${label}_[a-f0-9]+)_BEGIN\\n([\\s\\S]*?)\\n\\1_END`),
  );
  return match ? JSON.parse(match[2]) : undefined;
}

function completion(content) {
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
}

async function chat(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push(body);
  const system = body.messages?.[0]?.content ?? '';
  const user = body.messages?.[1]?.content ?? '';
  if (system.includes('Return one JSON object only')) {
    json(response, completion({ ok: true }));
    return;
  }
  if (system.includes('独立证据复核器')) {
    const data = extract(user, 'VERIFY') ?? [];
    json(
      response,
      completion({
        verdicts: data.map((claim) => ({
          claimId: claim.claimId,
          citations: claim.citations.map((citation) => ({
            blockId: citation.blockId,
            relation: claim.statement.includes('关系不匹配') ? 'limits' : citation.proposedRelation,
          })),
        })),
      }),
    );
    return;
  }
  const data = extract(user, 'SOURCE');
  const question = data?.question ?? '';
  if (/停止测试|处理中变化/.test(question))
    await new Promise((resolve) => setTimeout(resolve, 1500));
  const blocks = data?.blocks ?? [];
  const key =
    blocks.find((block) => block.content.includes('八十分钟')) ??
    blocks.find((block) => block.content.includes('同一段文字')) ??
    blocks[0];
  const invalid = question.includes('无效引用');
  const mismatch = question.includes('关系不匹配');
  json(
    response,
    completion({
      claims: [
        {
          id: 'claim-1',
          statement: mismatch ? '关系不匹配测试主张' : '试点中，新方案缩短了平均处理时间。',
          importance: 'key',
          citations: [
            ...(invalid ? [{ blockId: 'fabricated-block-id', relation: 'supports' }] : []),
            { blockId: key?.id ?? 'missing', relation: 'supports' },
          ],
          quote: '模型伪造的原文摘录',
        },
      ],
      unanswered: [],
    }),
  );
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:4173');
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    response.end();
    return;
  }
  if (url.pathname === '/chat/completions' && request.method === 'POST') {
    await chat(request, response);
    return;
  }
  if (url.pathname === '/requests') {
    json(response, requests);
    return;
  }
  if (url.pathname === '/reset') {
    requests.length = 0;
    json(response, { ok: true });
    return;
  }
  if (url.pathname === '/large') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="zh-CN"><head><title>超长资料</title></head><body><article><h1>超长资料</h1><p>开头段落用于确认文章能够建立足够的唯一证据锚点。</p><p>${'证据内容。'.repeat(18000)}</p><p>结尾段落用于确认全文没有被静默截断，也不会只发送前面的部分。</p></article></body></html>`,
    );
    return;
  }
  const fixture = {
    '/article': 'article.html',
    '/repeated': 'repeated.html',
    '/short': 'short.html',
  }[url.pathname];
  if (fixture) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(join(root, fixture)));
    return;
  }
  response.writeHead(404).end('Not found');
});

server.listen(4173, '127.0.0.1', () => console.log('E2E fixture server listening on 4173'));
