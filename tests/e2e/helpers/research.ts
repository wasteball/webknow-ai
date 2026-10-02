import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import type { NetworkMode } from '../../../src/core/search/agent-types';
import { outboundFixture } from './consent';

export type Scenario = 'latest' | 'retry' | 'ambiguous' | 'stale' | 'conflict' | 'empty' | 'injection' | 'content-failure';
export type TransportRecord = { url: string; body: string; method: string; credentials?: string; redirect?: string; headers: Record<string, string> };
const ARTICLE = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>城市配送试点研究</title><body><article><h1>城市配送试点研究</h1><p>本研究观察三个配送团队四周，比较新的路径方案与原有方案的处理时间。</p><p>试点期间，新方案的平均处理时间为八十分钟，原方案为一百分钟。</p><p>仅三个团队不能证明所有城市均适用。</p></article></body></html>';

/** Real packaged extraction/router/runner/actions/auditors; only worker fetch is scripted.
 * Loopback is the article/search transport only. Evidence URLs remain public-safe.
 * No credentials are live. This does not validate provider semantics, DNS or native prompts.
 */
export async function launchResearchFixture(options: { scenario?: Scenario; enabled?: boolean; width?: number; height?: number; large?: boolean } = {}) {
  const scenario = options.scenario ?? 'latest';
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(ARTICLE); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const extension = resolve(process.cwd(), '.output/chrome-mv3-e2e');
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wka-research-')), {
    channel: 'chromium', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: options.width ?? 560, height: options.height ?? 900 },
  });
  try {
    const unexpected: string[] = [];
    await context.route('https://**/*', async route => { unexpected.push(route.request().url()); await route.abort('blockedbyclient'); });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const config = { apiKeys: { deepseek: 'sk-synthetic-model-only' }, appearance: { fontSize: options.large ? 'large' : 'normal' },
      search: { providerId: scenario === 'content-failure' ? 'firecrawl' : 'bocha',
        credentials: { bocha: { apiKey: 'sk-synthetic-search-only' } }, agent: { enabled: options.enabled ?? true } } };
    await worker.evaluate(async config => chrome.storage.local.set({ config }), { ...config, outbound: outboundFixture(config) });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await worker.evaluate(({ origin, scenario }) => {
      type Payload = Record<string, any>;
      const state = { records: [] as TransportRecord[], phases: [] as string[], actions: 0, searches: 0, time: null as Payload | null,
        hold: '', release: null as null | (() => void), aborted: 0 };
      (globalThis as any).__research = state;
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input); const headers = Object.fromEntries(new Headers(init.headers).entries());
        const body = typeof init.body === 'string' ? init.body : '';
        state.records.push({ url, body, headers, method: init.method ?? 'GET', credentials: init.credentials, redirect: init.redirect });
        const hold = async (phase: string) => {
          state.phases.push(phase);
          if (state.hold !== phase) return;
          await new Promise<void>((resolve, reject) => {
            state.release = resolve;
            init.signal?.addEventListener('abort', () => { state.aborted++; reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
          });
        };
        if (url.startsWith(origin) || url.endsWith('/v2/search') || url.endsWith('/v1/web-search')) {
          await hold('searching'); state.searches++;
          const results = scenario === 'empty' || (scenario === 'retry' && state.searches === 1) ? [] : [
            { title: 'Atlas 官方版本公告', url: 'https://example.org/atlas/release', content: 'Atlas 当前版本为 3。', description: 'Atlas 当前版本为 3。',
              publishedDate: scenario === 'stale' ? '2020-01-01' : state.time!.localDate },
            ...(scenario === 'conflict' ? [{ title: 'Atlas 另一公告', url: 'https://example.net/atlas/release', content: 'Atlas 当前版本为 2。', publishedDate: state.time!.localDate }] : []),
          ];
          return url.endsWith('/v2/search') ? json({ data: { web: results } }) : url.endsWith('/v1/web-search') ? json({ data: { webPages: { value: results.map(r => ({ name: r.title, url: r.url, summary: r.content, datePublished: r.publishedDate })) } } }) : json({ results });
        }
        if (url.endsWith('/v2/scrape')) { await hold('reading'); return json({ error: 'Synthetic content failure' }, 503); }
        if (!url.includes('/chat/completions')) throw new Error(`Unexpected synthetic transport: ${url}`);
        const messages = JSON.parse(body).messages as { role: string; content: string }[];
        const system = messages[0]!.content;
        const user = messages.at(-1)!.content;
        let output: unknown;
        if (!system.includes('受控联网研究循环') && !system.includes('独立研究审查器')) {
          // Actual initial extraction/guide and ordinary article-only answer path.
          output = system.includes('followUps') ? { answer: '文章观察三个团队四周，不能证明所有城市均适用。', source: 'original', citations: [], unanswered: [], followUps: [] }
            : { summary: '试点观察三个团队四周，处理时间缩短。', bubbles: [] };
        } else {
          const data = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1)) as Payload;
          state.time = data.gate?.time ?? data.time;
          const sources = data.ledger?.sources ?? data.sources ?? [];
          const ids = sources.map((s: Payload) => s.sourceId);
          if (system.includes('逐一审查')) {
            await hold('checking');
            output = { sources: ids.map((sourceId: string) => ({ sourceId, relevant: true, supportedAspects: ['Atlas 版本'], reason: '固定合成公告，仅摘要依据' })),
              missing: ids.length ? [] : ['没有版本资料'], conflicts: scenario === 'conflict' ? [{ sourceIds: ids, description: '两份公告版本冲突，无法确认最新版本。' }] : [] };
          } else if (system.includes('审查 candidate')) {
            await hold('answering');
            output = { decision: 'accept', claims: data.candidate.source === 'extended' ? [{ text: '公告中的版本', sourceIds: data.candidate.references }] : [],
              missing: [], conflicts: [], freshness: data.candidate.freshness };
          } else {
            await hold('deciding'); state.actions++;
            const clarifications = data.untrustedIntent?.clarifications ?? [];
            if (scenario === 'ambiguous' && !clarifications.length) output = { type: 'ask_user', question: '你指哪个 Atlas 产品？', reason: 'ambiguous_entity' };
            else if (scenario === 'injection' && state.actions <= 2) output = { type: 'send_key', key: 'untrusted-page-command' };
            else if (!data.gate.canSearch || data.gate.level === 'not_needed') output = { type: 'finish_answer', answer: '文章观察三个团队四周；当前未联网核验。', source: 'original', citations: [], references: [], unanswered: [], freshness: 'not_applicable' };
            else if (!data.ledger.attempts.length || (scenario === 'retry' && data.ledger.attempts.length === 1)) output = { type: 'search_web',
              query: data.ledger.attempts.length ? 'Atlas 官方发布版本公告' : 'Atlas 当前版本', purpose: 'latest', freshness: data.gate.freshness, language: 'zh-CN', domains: [], maxResults: 5 };
            else if (scenario === 'content-failure' && !data.progress.readIds.length) output = { type: 'read_sources', sourceIds: ids.slice(0, 1), focus: '核对版本' };
            else {
              const uncertain = scenario === 'empty' || scenario === 'conflict';
              const stale = scenario === 'stale'; const unknownDate = scenario === 'content-failure';
              output = { type: 'finish_answer', answer: uncertain ? (scenario === 'conflict' ? '两份公告版本冲突，无法确认最新版本。' : '未找到资料，无法确认最新版本。')
                : stale ? '2020 年公告记载版本 3；资料较旧，无法确认最新版本。'
                  : unknownDate ? '根据网络摘要，公告记载版本 3；日期未知，无法确认最新版本。'
                    : '根据网络资料，Atlas 当前版本为 3。',
                source: uncertain ? 'unknown' : 'extended', citations: [], references: uncertain ? [] : ids,
                unanswered: uncertain || stale || unknownDate ? ['无法确认最新版本'] : [],
                freshness: uncertain ? 'not_applicable' : stale ? 'stale' : unknownDate ? 'date_unknown' : 'verified' };
            }
          }
        }
        const text = JSON.stringify(output);
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } });
      };
    }, { origin, scenario });
    const article = await context.newPage(); await article.goto(`${origin}/article.html`); await article.bringToFront();
    const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]!.id!);
    await worker.evaluate(async ({ tabId, origin }) => chrome.storage.session.set({ [`pending:${tabId}`]: { url: `${origin}/article.html`, origin, at: Date.now() } }), { tabId, origin });
    await panel.reload(); await panel.getByRole('button', { name: '开始阅读', exact: true }).click();
    await expect(panel.locator('.said-guide')).toBeVisible();
    const hits: string[] = [];
    let completedTurns = 0;
    const records = async (): Promise<TransportRecord[]> => worker.evaluate(() => (globalThis as any).__research.records);
    const syncHits = async () => {
      hits.splice(0, hits.length, ...(await records()).filter(r => r.url.includes('/search') || r.url.includes('/web-search')).map(r => r.body || new URL(r.url).searchParams.get('q') || ''));
    };
    return { panel, article, context, worker, tabId, extensionId, hits, records, unexpected,
      async ask(question: string, mode: NetworkMode) {
        completedTurns = await worker.evaluate(async id => (await chrome.storage.session.get(`sess:${id}`))[`sess:${id}`]?.chat.length ?? 0, tabId);
        await panel.getByLabel('本题联网方式').selectOption(mode);
        await panel.getByLabel('向这篇文章提问').fill(question);
        await panel.getByRole('button', { name: '发送', exact: true }).click();
      },
      async waitFinished() {
        await expect.poll(async () => worker.evaluate(async ({ tabId, completedTurns }) => {
          const saved = await chrome.storage.session.get(`sess:${tabId}`); return saved[`sess:${tabId}`]?.chat.length > completedTurns && saved[`sess:${tabId}`]?.run == null;
        }, { tabId, completedTurns })).toBe(true);
        completedTurns++;
        await expect(panel.locator('#mode-panel-qa .msg.ai .said:not(.said-guide)').last()).toBeVisible();
        await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeHidden();
        await expect.poll(async () => worker.evaluate(async id => {
          const saved = await chrome.storage.session.get(`sess:${id}`); return saved[`sess:${id}`]?.run == null;
        }, tabId)).toBe(true);
        await syncHits();
      },
      async hold(phase: string) { await worker.evaluate(phase => { (globalThis as any).__research.hold = phase; (globalThis as any).__research.phases = []; }, phase); },
      async waitPhase(phase: string) { await expect.poll(() => worker.evaluate(phase => (globalThis as any).__research.phases.includes(phase), phase)).toBe(true); await syncHits(); },
      async release() { await worker.evaluate(() => (globalThis as any).__research.release?.()); },
      async stopped() { await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeHidden(); await syncHits(); },
      async close() { await context.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); },
    };
  } catch (error) {
    await context.close();
    await new Promise<void>((done, reject) => server.close(failure => failure ? reject(failure) : done()));
    throw error;
  }
}
