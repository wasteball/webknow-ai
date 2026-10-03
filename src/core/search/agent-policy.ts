import { DEFAULT_SEARCH_AGENT_POLICY } from '../prompts/search-agent';
import { LIMITS } from '../limits';
import type { AgentSettings } from './agent-types';

/** Empty locale strings follow the browser; empty policy selects the single built-in policy. */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: false, freshness: 'auto', depth: 'deep', language: '', region: '',
  preferredDomains: [], sourceReading: 'provider', policy: '',
};

const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeAgentSettings(patch: unknown): Partial<AgentSettings> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const input = patch as Record<string, unknown>;
  const clean: Partial<AgentSettings> = {};
  if (typeof input.enabled === 'boolean') clean.enabled = input.enabled;
  if (typeof input.freshness === 'string' && ['auto', 'live', 'day', 'week', 'month', 'any'].includes(input.freshness)) {
    clean.freshness = input.freshness as AgentSettings['freshness'];
  }
  if (input.depth === 'quick' || input.depth === 'deep') clean.depth = input.depth;
  if (input.sourceReading === 'off' || input.sourceReading === 'provider' || input.sourceReading === 'direct_allowed') {
    clean.sourceReading = input.sourceReading;
  }
  for (const key of ['language', 'region', 'policy'] as const) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    const max = key === 'policy' ? LIMITS.maxTeachingPromptChars : 40;
    if (trimmed.length <= max && !controls.test(trimmed) && (key === 'policy' || !/[\r\n\t]/.test(trimmed))) clean[key] = trimmed;
  }
  if (Array.isArray(input.preferredDomains)) {
    clean.preferredDomains = [...new Set(input.preferredDomains
      .filter((domain): domain is string => typeof domain === 'string')
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain.length <= 253 && hostname.test(domain)))].slice(0, 5);
  }
  return clean;
}

/** Legacy records remain stored, but product defaults alone govern research. */
export function effectiveAgentSettings(_config: { search?: { agent?: Partial<AgentSettings> } }): AgentSettings {
  return { ...DEFAULT_AGENT_SETTINGS, preferredDomains: [], policy: DEFAULT_SEARCH_AGENT_POLICY };
}

/** Saved empty values follow the browser, resolved once when freezing the run. No geolocation. */
export function runtimeAgentSettings(config: Parameters<typeof effectiveAgentSettings>[0], locale: string): AgentSettings {
  const settings = effectiveAgentSettings(config);
  let browserLocale: Intl.Locale;
  try { browserLocale = new Intl.Locale(locale); } catch { browserLocale = new Intl.Locale('en'); }
  return { ...settings, language: settings.language || browserLocale.toString(), region: settings.region || browserLocale.region || '' };
}
