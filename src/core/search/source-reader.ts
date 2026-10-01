import type { AgentSettings, EvidenceLedger, SourceRead } from './agent-types';
import { AGENT_LIMITS } from './agent-limits';
import { extractSourceHtml, sourceAccessWarningText, sourcePublishedAt } from './source-extract';
import { publicSourceUrl } from './source-url';

/** MV3 Fetch cannot prove DNS/public-target isolation. Preference/host grants cannot override this. */
export const DIRECT_READ_VERIFIED = false;
export type ProviderRead = (sources: { sourceId: string; url: string }[], signal: AbortSignal) => Promise<SourceRead[]>;
const MAX_BODY_BYTES = 1024 * 1024;

export class SourceBodyFailure extends Error {
  constructor(readonly warning: string) { super(warning); }
}

/** Reject promptly even when a supplied adapter fails to implement cancellation. */
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([pending, cancelled]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener('abort', abort); }
}

/** Shared by direct HTML and provider JSON. Counts decoded stream bytes, never calls unbounded text/json(). */
export async function readBoundedSourceBody(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!response.body) return '';
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  const chunks: string[] = [];
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new SourceBodyFailure('source_body_too_large');
      chunks.push(decoder.decode(next.value, { stream: true }));
      if (bytes === MAX_BODY_BYTES) throw new SourceBodyFailure('source_body_too_large');
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readSources(input: {
  ids: string[]; focus: string; ledger: EvidenceLedger; mode: AgentSettings['sourceReading'];
  remainingChars: number; signal: AbortSignal; now: () => Date; providerRead?: ProviderRead;
  hasPermission: (origin: string) => Promise<boolean>; directReadVerified: boolean; fetchImpl?: typeof fetch;
}): Promise<SourceRead[]> {
  input.signal.throwIfAborted();
  const ids = [...new Set(input.ids)];
  let remaining = Math.max(0, Math.min(AGENT_LIMITS.totalSourceChars, Number.isFinite(input.remainingChars) ? Math.floor(input.remainingChars) : 0));
  const unavailable = (sourceId: string, warning: string): SourceRead => ({ sourceId, text: '',
    publishedAt: null, retrievedAt: input.now().toISOString(), status: 'unavailable', warnings: [warning] });
  const selected = new Map<string, URL>();
  const results = new Map<string, SourceRead>();
  for (const sourceId of ids) {
    const source = input.ledger.sources.find(item => item.sourceId === sourceId);
    const url = source && publicSourceUrl(source.url);
    const warning = !source ? 'source_id_unknown' : !url ? 'source_url_blocked' : input.mode === 'off' ? 'source_reading_off'
      : selected.size >= AGENT_LIMITS.sourceReads ? 'source_page_limit' : !remaining ? 'source_character_limit' : null;
    if (warning) results.set(sourceId, unavailable(sourceId, warning));
    else selected.set(sourceId, url!);
  }
  const accept = (sourceId: string, raw: unknown) => {
    if (!raw || typeof raw !== 'object') { results.set(sourceId, unavailable(sourceId, 'source_provider_unavailable')); return; }
    const item = raw as Partial<SourceRead>;
    const warnings = Array.isArray(item.warnings) ? item.warnings.filter((w): w is string => typeof w === 'string').slice(0, 20).map(w => w.slice(0, 200)) : [];
    if (item.sourceId !== sourceId || item.status !== 'read' || typeof item.text !== 'string' || !item.text.trim()) {
      const result = unavailable(sourceId, 'source_provider_unavailable');
      if (item.sourceId === sourceId && item.status === 'unavailable' && warnings.length) result.warnings = warnings;
      results.set(sourceId, result); return;
    }
    if (!remaining) { results.set(sourceId, unavailable(sourceId, 'source_character_limit')); return; }
    const limit = Math.min(AGENT_LIMITS.sourceChars, remaining);
    const text = item.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (!text) { results.set(sourceId, unavailable(sourceId, 'source_empty')); return; }
    if (text.length > limit && !warnings.includes('source_text_truncated')) warnings.push('source_text_truncated');
    const content = text.slice(0, limit);
    remaining -= content.length;
    results.set(sourceId, { sourceId, text: content, publishedAt: sourcePublishedAt(item.publishedAt), retrievedAt: input.now().toISOString(), status: 'read', warnings });
  };
  if (selected.size && input.providerRead) {
    // Provider failures never silently fall through to a different transport.
    let reads: unknown = [];
    try { reads = await abortable(input.providerRead([...selected].map(([sourceId, url]) => ({ sourceId, url: url.href })), input.signal), input.signal); }
    catch { input.signal.throwIfAborted(); }
    for (const sourceId of selected.keys()) {
      const matches = Array.isArray(reads) ? reads.filter(r => r && typeof r === 'object' && r.sourceId === sourceId) : [];
      accept(sourceId, matches.length === 1 ? matches[0] : null);
    }
  } else {
    for (const [sourceId, url] of selected) {
      input.signal.throwIfAborted();
      if (!remaining || input.mode !== 'direct_allowed' || !input.directReadVerified) {
        results.set(sourceId, unavailable(sourceId, !remaining ? 'source_character_limit' : 'source_direct_unavailable')); continue;
      }
      try {
        if (!await abortable(input.hasPermission(url.origin), input.signal)) {
          results.set(sourceId, unavailable(sourceId, 'source_permission_missing')); continue;
        }
        const response = await abortable((input.fetchImpl ?? fetch)(url, {
          method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: { Accept: 'text/html, text/plain;q=0.8' }, signal: input.signal,
        }), input.signal);
        const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
        if (!response.ok || response.redirected || (response.url && response.url !== url.href) ||
            !['text/html', 'text/plain'].includes(type ?? '') || /\battachment\b/i.test(response.headers.get('Content-Disposition') ?? '')) {
          await response.body?.cancel().catch(() => {});
          throw new SourceBodyFailure('source_response_blocked');
        }
        const raw = await readBoundedSourceBody(response, input.signal);
        const challenge = type === 'text/plain' ? sourceAccessWarningText(raw) : null;
        if (challenge) { results.set(sourceId, unavailable(sourceId, challenge)); continue; }
        const limit = Math.min(AGENT_LIMITS.sourceChars, remaining);
        const extracted = type === 'text/html' ? extractSourceHtml(raw, limit) : {
          text: raw.slice(0, limit), publishedAt: null, warnings: raw.length > limit ? ['source_text_truncated'] : [],
        };
        if (!extracted.text.trim()) { results.set(sourceId, unavailable(sourceId, extracted.warnings[0] ?? 'source_empty')); continue; }
        accept(sourceId, { sourceId, ...extracted, status: 'read' });
      } catch (error) {
        input.signal.throwIfAborted();
        results.set(sourceId, unavailable(sourceId, error instanceof SourceBodyFailure ? error.warning : 'source_read_failed'));
      }
    }
  }
  input.signal.throwIfAborted();
  return ids.map(id => results.get(id)!);
}
