import { PageRequestSchema } from '../src/contracts';
import { captureDocument, disposeHighlight, documentFingerprint, jumpToAnchor } from '../src/page';

declare global {
  interface Window {
    __WKA_PAGE_LISTENER__?: (message: unknown) => Promise<unknown> | undefined;
  }
}

export default defineUnlistedScript(() => {
  const previous = window.__WKA_PAGE_LISTENER__;
  if (previous) browser.runtime.onMessage.removeListener(previous);

  const listener = (raw: unknown): Promise<unknown> | undefined => {
    const parsed = PageRequestSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const request = parsed.data;
    switch (request.type) {
      case 'CAPTURE':
        return Promise.resolve(captureDocument(request.sessionId));
      case 'GET_FINGERPRINT':
        return Promise.resolve({ fingerprint: documentFingerprint() });
      case 'JUMP':
        return Promise.resolve(jumpToAnchor(request.anchor));
      case 'DISPOSE_HIGHLIGHT':
        disposeHighlight();
        return Promise.resolve({ ok: true });
    }
  };
  window.__WKA_PAGE_LISTENER__ = listener;
  browser.runtime.onMessage.addListener(listener);
});
