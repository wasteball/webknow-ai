import { expect, it, vi } from 'vitest';
import type { EvidenceLedger, SourceRead, SourceRecord } from '../src/core/search/agent-types';
import { DIRECT_READ_VERIFIED, readSources } from '../src/core/search/source-reader';
import { firecrawl } from '../src/core/search/providers';

const signal = () => new AbortController().signal;
const now = () => new Date('2026-10-01T08:00:00Z');
function source(sourceId: string, url = `https://example.com/${sourceId}`): SourceRecord {
  return { sourceId, url, title: sourceId, domain: 'example.com', snippet: 'available summary', provider: 'firecrawl',
    attempts: [1], publishedAt: null, retrievedAt: now().toISOString(), readStatus: 'not_read',
    decision: 'candidate', dateStatus: 'date_unknown', warnings: [] };
}
const ledger: EvidenceLedger = { runId: 'r1', sources: [source('sr_r1_1')], attempts: [], assessment: null };
function options() { return { ids: ['sr_r1_1'], focus: '核验', ledger, mode: 'direct_allowed' as const,
  remainingChars: 40_000, signal: signal(), now, hasPermission: async () => true, directReadVerified: true }; }
function read(sourceId: string, text = 'provider body'): SourceRead {
  return { sourceId, text, publishedAt: '2026-10-01', retrievedAt: 'untrusted clock', status: 'read', warnings: [] };
}
const htmlFetch = () => vi.fn<typeof fetch>(async () => new Response('<article>public body</article>', { headers: { 'Content-Type': 'text/html' } }));

it('never fetches an id that is absent from this run (including model URL strings)', async () => {
  const fetchImpl = htmlFetch();
  const providerRead = vi.fn(async () => []);
  const result = await readSources({ ...options(), ids: ['sr_other_1', 'https://evil.example.com'], fetchImpl, providerRead });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(providerRead).not.toHaveBeenCalled();
  expect(result).toEqual(['sr_other_1', 'https://evil.example.com'].map(sourceId => expect.objectContaining({ sourceId, status: 'unavailable', text: '' })));
});

it('validates ledger URLs before either transport and leaves summaries intact', async () => {
  const unsafe = { ...ledger, sources: [source('sr_r1_1', 'http://127.1/')] };
  const providerRead = vi.fn(async () => [read('sr_r1_1')]);
  const fetchImpl = htmlFetch();
  await readSources({ ...options(), ledger: unsafe, providerRead, fetchImpl });
  expect(providerRead).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  expect(unsafe.sources[0]?.snippet).toBe('available summary');
});

it.each([
  { mode: 'off' as const }, { mode: 'provider' as const },
  { directReadVerified: false }, { hasPermission: async () => false },
])('requires all direct-read conditions %j', async (gate) => {
  const fetchImpl = htmlFetch();
  expect((await readSources({ ...options(), ...gate, fetchImpl }))[0]?.status).toBe('unavailable');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('hard-codes the unverified production capability to false', () => expect(DIRECT_READ_VERIFIED).toBe(false));

it('off prevents provider calls too', async () => {
  const providerRead = vi.fn(async () => [read('sr_r1_1')]);
  await readSources({ ...options(), mode: 'off', providerRead });
  expect(providerRead).not.toHaveBeenCalled();
});

it('prefers provider content, validates returned IDs/text, and uses the program clock', async () => {
  const fetchImpl = htmlFetch();
  const providerRead = vi.fn(async () => [read('foreign'), read('sr_r1_1')]);
  const result = await readSources({ ...options(), providerRead, fetchImpl });
  expect(providerRead).toHaveBeenCalledWith([{ sourceId: 'sr_r1_1', url: 'https://example.com/sr_r1_1' }], expect.any(AbortSignal));
  expect(result).toEqual([{ ...read('sr_r1_1'), retrievedAt: now().toISOString() }]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each([async () => { throw new Error('sensitive supplier body'); }, async () => [read('foreign')],
  async () => [{ ...read('sr_r1_1'), text: 123 } as unknown as SourceRead], async () => [read('sr_r1_1', '  ')],
])('provider failure or invalid output never falls through to direct fetch', async (providerRead) => {
  const fetchImpl = htmlFetch();
  const result = await readSources({ ...options(), providerRead, fetchImpl });
  expect(result[0]).toMatchObject({ status: 'unavailable', text: '' });
  expect(JSON.stringify(result)).not.toContain('sensitive supplier body');
  expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.sources[0]?.snippet).toBe('available summary');
});

it('bounds each provider page, the remaining run characters, and page count', async () => {
  const sources = Array.from({ length: 6 }, (_, i) => source(`sr_r1_${i}`));
  const providerRead = vi.fn(async (requested: {sourceId: string}[]) => requested.map(s => read(s.sourceId, 'x'.repeat(15_000))));
  const result = await readSources({ ...options(), ledger: { ...ledger, sources }, ids: sources.map(s => s.sourceId), providerRead });
  expect(result.map(r => r.text.length)).toEqual([12_000, 12_000, 12_000, 4_000, 0, 0]);
  expect(result.slice(0, 4).every(r => r.warnings.includes('source_text_truncated'))).toBe(true);
  expect(providerRead.mock.calls[0]?.[0]).toHaveLength(5);
});

it('direct read checks the exact origin and sends only anonymous GET options', async () => {
  const fetchImpl = htmlFetch(); const hasPermission = vi.fn(async () => true);
  const result = await readSources({ ...options(), hasPermission, fetchImpl });
  expect(hasPermission).toHaveBeenCalledWith('https://example.com');
  expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), { method: 'GET', credentials: 'omit', redirect: 'error',
    referrerPolicy: 'no-referrer', headers: { Accept: 'text/html, text/plain;q=0.8' }, signal: expect.any(AbortSignal) });
  expect(result[0]?.text).toBe('public body');
});

it.each<ResponseInit>([
  { status: 302, headers: { 'Content-Type': 'text/html', Location: 'http://127.0.0.1' } },
  { headers: { 'Content-Type': 'application/pdf' } },
  { headers: { 'Content-Type': 'text/html', 'Content-Disposition': 'attachment; filename=x.html' } },
  { headers: {} },
])('rejects redirect/file/attachment/unknown type %j', async (init) => {
    const result = await readSources({ ...options(), fetchImpl: async () => new Response(new TextEncoder().encode('body'), init) });
  expect(result[0]?.status).toBe('unavailable');
});

it('reads text/plain and labels total-limit truncation', async () => {
  const result = await readSources({ ...options(), remainingChars: 4,
    fetchImpl: async () => new Response('abcdef', { headers: { 'Content-Type': 'text/plain' } }) });
  expect(result[0]).toMatchObject({ text: 'abcd', status: 'read', warnings: ['source_text_truncated'] });
});

it('stops streaming at 1 MiB and cancels the body', async () => {
  const cancel = vi.fn(); let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(262_144).fill(120)); }, cancel });
  const result = await readSources({ ...options(), fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'text/plain' } }) });
  expect(result[0]?.status).toBe('unavailable'); expect(result[0]?.warnings).toContain('source_body_too_large');
  expect(cancel).toHaveBeenCalled(); expect(pulls).toBeLessThanOrEqual(6);
});

it('abort cancels a pending body reader and rejects instead of returning evidence', async () => {
  const abort = new AbortController(); const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const pending = readSources({ ...options(), signal: abort.signal, fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'text/plain' } }) });
  await new Promise(resolve => setTimeout(resolve, 10)); abort.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalled();
});

it('ignores late provider results after cancellation even if the adapter ignores its signal', async () => {
  const abort = new AbortController();
  const pending = readSources({ ...options(), signal: abort.signal, providerRead: async () => new Promise(() => {}) });
  abort.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

it('Firecrawl content adapter uses the verified fixed endpoint, sanitizes and bounds content', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { markdown: '<script>evil</script>Public text', metadata: { datePublished: '2026-10-01' } } })));
  const result = await firecrawl.readSources!({ sources: [{ sourceId: 'sr_r1_1', url: 'https://example.com/article' }], signal: signal(), config: { apiKey: 'must-not-send' }, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledWith('https://api.firecrawl.dev/v2/scrape', expect.objectContaining({ method: 'POST', credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) }));
  const init = fetchImpl.mock.calls[0]?.[1];
  expect(JSON.parse(init?.body as string)).toEqual({ url: 'https://example.com/article', formats: ['markdown'] });
  expect(JSON.stringify(init)).not.toContain('must-not-send');
  expect(result[0]).toMatchObject({ sourceId: 'sr_r1_1', text: 'Public text', publishedAt: null, status: 'read' });
});

it('Firecrawl rejects unsafe destinations and sanitizes per-page failures', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('secret', { status: 403 }));
  const result = await firecrawl.readSources!({ sources: [{ sourceId: 'sr_r1_1', url: 'http://127.1/' }, { sourceId: 'sr_r1_2', url: 'https://example.com/' }], signal: signal(), config: {}, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(result.every(r => r.status === 'unavailable' && r.text === '')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('preserves unavailable provider warnings', async () => {
  const unavailable = { ...read('sr_r1_1'), status: 'unavailable' as const, text: '', warnings: ['source_captcha_page'] };
  const rejected = await readSources({ ...options(), providerRead: async () => [unavailable] });
  expect(rejected[0]?.warnings).toContain('source_captcha_page');
});

it('rejects provider text consisting only of controls', async () => {
  const control = await readSources({ ...options(), providerRead: async () => [read('sr_r1_1', '\u0000\u0007')] });
  expect(control[0]?.status).toBe('unavailable');
});

it('refuses duplicate provider results, deduplicates requested IDs, and clamps run allowance', async () => {
  const duplicated = await readSources({ ...options(), providerRead: async () => [read('sr_r1_1'), read('sr_r1_1')] });
  expect(duplicated[0]?.status).toBe('unavailable');
  const providerRead = vi.fn(async () => [read('sr_r1_1', 'x'.repeat(15_000))]);
  const result = await readSources({ ...options(), ids: ['sr_r1_1', 'sr_r1_1'], remainingChars: 1_000_000, providerRead });
  expect(result).toHaveLength(1); expect(result[0]?.text).toHaveLength(12_000);
  const none = await readSources({ ...options(), remainingChars: 0, providerRead });
  expect(none[0]?.status).toBe('unavailable'); expect(providerRead).toHaveBeenCalledTimes(1);
});

it('direct multi-page reads share the remaining allowance and never request pages after it expires', async () => {
  const sources = [source('sr_r1_1'), source('sr_r1_2'), source('sr_r1_3')];
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('x'.repeat(20_000), { headers: { 'Content-Type': 'text/plain' } }));
  const result = await readSources({ ...options(), ledger: { ...ledger, sources }, ids: sources.map(s => s.sourceId), remainingChars: 13_000, fetchImpl });
  expect(result.map(r => r.text.length)).toEqual([12_000, 1_000, 0]);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it.each(['<form><input type="password"></form>', '<title>Verify you are human</title>', '<script>bad()</script><img src="https://evil.example.com/img">'])('direct rejects inaccessible or empty HTML without subrequests', async (html) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }));
  const result = await readSources({ ...options(), fetchImpl });
  expect(result[0]?.status).toBe('unavailable'); expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each(['not json', JSON.stringify({ data: {} }), JSON.stringify({ data: { markdown: '<form><input type="password"></form>' } })])('Firecrawl fails closed on malformed, missing or access-gated content', async (payload) => {
  const result = await firecrawl.readSources!({ sources: [{ sourceId: 'sr_r1_1', url: 'https://example.com/' }], signal: signal(), config: {}, fetchImpl: async () => new Response(payload) });
  expect(result[0]?.status).toBe('unavailable'); expect(result[0]?.text).toBe('');
});

it('Firecrawl bounds response bytes before parsing JSON and cancels oversized streams', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(262_144).fill(120)); }, cancel });
  const result = await firecrawl.readSources!({ sources: [{ sourceId: 'sr_r1_1', url: 'https://example.com/' }], signal: signal(), config: {}, fetchImpl: async () => new Response(stream) });
  expect(result[0]?.warnings).toContain('source_body_too_large'); expect(cancel).toHaveBeenCalled();
});

it('abort before a read starts makes no request', async () => {
  const abort = new AbortController(); abort.abort();
  const fetchImpl = htmlFetch();
  await expect(readSources({ ...options(), signal: abort.signal, fetchImpl })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('rejects text/plain access challenges', async () => {
  const result = await readSources({ ...options(), fetchImpl: async () => new Response('Verify you are human to continue.', { headers: { 'Content-Type': 'text/plain' } }) });
  expect(result[0]).toMatchObject({ status: 'unavailable', warnings: ['source_captcha_page'] });
});

it('Firecrawl truncates and shares the total allowance without fetching further pages', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { markdown: 'x'.repeat(15_000) } })));
  const result = await firecrawl.readSources!({ sources: Array.from({length: 6}, (_, i) => ({ sourceId: `sr_r1_${i}`, url: `https://example.com/${i}` })), signal: signal(), config: {}, fetchImpl });
  expect(result.map(r => r.text.length)).toEqual([12_000, 12_000, 12_000, 4_000, 0, 0]);
  expect(result.slice(0, 4).every(r => r.warnings.includes('source_text_truncated'))).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

async function settledSoon<T>(pending: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error })),
      new Promise<{kind: 'pending'}>(resolve => { timer = setTimeout(() => resolve({ kind: 'pending' }), 100); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

it('aborted body reads settle and release their lock even if underlying cancellation never settles', async () => {
  const abort = new AbortController();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const stream = new ReadableStream<Uint8Array>({ cancel });
  const pending = readSources({ ...options(), signal: abort.signal, fetchImpl: async () => new Response(stream, { headers: { 'Content-Type': 'text/plain' } }) });
  // Wait until the production reader holds the stream; abort then cancels a pending read.
  await vi.waitFor(() => expect(stream.locked).toBe(true));
  abort.abort();
  expect(await settledSoon(pending)).toMatchObject({ kind: 'rejected', error: { name: 'AbortError' } });
  expect(cancel).toHaveBeenCalledTimes(1); expect(stream.locked).toBe(false);
});

it('oversized body reads settle even if cancellation never settles', async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(262_144).fill(120)); }, cancel });
  const result = await settledSoon(readSources({ ...options(), fetchImpl: async () => new Response(stream, { headers: { 'Content-Type': 'text/plain' } }) }));
  expect(result).toMatchObject({ kind: 'resolved', value: [{ status: 'unavailable', warnings: ['source_body_too_large'] }] });
  expect(cancel).toHaveBeenCalledTimes(1); expect(stream.locked).toBe(false);
});

it('aborted body reads settle and release locks when a reader ignores cancel entirely', async () => {
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>();
  const getReader = stream.getReader.bind(stream);
  const ignoredCancel = vi.fn(() => new Promise<void>(() => {}));
  // Simulate a hostile/nonconforming reader boundary: cancel neither closes nor settles.
  vi.spyOn(stream, 'getReader').mockImplementation(() => {
    const reader = getReader();
    vi.spyOn(reader, 'cancel').mockImplementation(ignoredCancel);
    return reader;
  });
  const pending = readSources({ ...options(), signal: abort.signal, fetchImpl: async () => new Response(stream, { headers: { 'Content-Type': 'text/plain' } }) });
  await vi.waitFor(() => expect(stream.locked).toBe(true));
  abort.abort();
  expect(await settledSoon(pending)).toMatchObject({ kind: 'rejected', error: { name: 'AbortError' } });
  expect(ignoredCancel).toHaveBeenCalled(); expect(stream.locked).toBe(false);
});

it.each(['pending', 'rejected'] as const)('blocked-response reads settle despite %s cancellation', async (mode) => {
  const cancel = vi.fn(() => mode === 'pending' ? new Promise<void>(() => {}) : Promise.reject(new Error('stream cancel failure')));
  const stream = new ReadableStream<Uint8Array>({ cancel });
  const result = await settledSoon(readSources({ ...options(), fetchImpl: async () => new Response(stream, { headers: { 'Content-Type': 'application/pdf' } }) }));
  expect(result).toMatchObject({ kind: 'resolved', value: [{ status: 'unavailable', warnings: ['source_response_blocked'] }] });
  expect(cancel).toHaveBeenCalledTimes(1); expect(stream.locked).toBe(false);
});

it('Firecrawl blocked-response cleanup does not wait on cancellation', async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const stream = new ReadableStream<Uint8Array>({ cancel });
  const result = await settledSoon(firecrawl.readSources!({ sources: [{ sourceId: 'sr_r1_1', url: 'https://example.com/' }], signal: signal(), config: {}, fetchImpl: async () => new Response(stream, { status: 403 }) }));
  expect(result).toMatchObject({ kind: 'resolved', value: [{ status: 'unavailable', warnings: ['source_provider_unavailable'] }] });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('allows exactly 1 MiB while rejecting one byte over the cap', async () => {
  const fetchImpl = (size: number) => async () => new Response('x'.repeat(size), { headers: { 'Content-Type': 'text/plain' } });
  const exact = await readSources({ ...options(), fetchImpl: fetchImpl(1024 * 1024) });
  expect(exact[0]).toMatchObject({ status: 'read', warnings: ['source_text_truncated'] });
  expect(exact[0]?.text).toHaveLength(12_000);
  const over = await readSources({ ...options(), fetchImpl: fetchImpl(1024 * 1024 + 1) });
  expect(over[0]).toMatchObject({ status: 'unavailable', warnings: ['source_body_too_large'] });
});

it('direct reads reject an SSO login form beside article text', async () => {
  const result = await readSources({ ...options(), fetchImpl: async () => new Response('<article>Public-looking excerpt.</article><form action="/auth"><button>Continue with Google</button></form>', { headers: { 'Content-Type': 'text/html' } }) });
  expect(result[0]).toMatchObject({ status: 'unavailable', text: '', warnings: ['source_login_page'] });
});
