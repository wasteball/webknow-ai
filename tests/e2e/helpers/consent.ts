import { OUTBOUND_NOTICE_VERSION, outboundScope } from '../../../src/core/settings';
import { findProvider } from '../../../src/core/model-providers';

/** Same public declaration as confirmOutbound, without weakening any runtime check. */
export function outboundFixture(config: Parameters<typeof outboundScope>[0] = {}) {
  return { version: OUTBOUND_NOTICE_VERSION, acceptedAt: Date.now(),
    receiver: findProvider(config.provider).receiver, scope: outboundScope(config) };
}
