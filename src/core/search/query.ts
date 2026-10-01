import type { SearchAction } from './agent-types';

type Dimension = 'entity' | 'wording' | 'domain' | 'time' | 'language';
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const domains = (action: SearchAction) => [...new Set(action.domains.map(value => normalize(value).toLowerCase()))].sort();
const language = (action: SearchAction) => normalize(action.language).toLowerCase();

/** Exact request identity, excluding result count and the model's purpose label. */
export function queryKey(action: SearchAction): string {
  return JSON.stringify([normalize(action.query), domains(action), action.freshness, language(action)]);
}

function parts(action: SearchAction) {
  const tokens = normalize(action.query).match(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|\S+/g) ?? [];
  // A generic latest adjective alone changes neither the entity nor the evidence strategy.
  const substantive = [...new Set(tokens.map(token => /^["'“‘]/.test(token) ? token
    : token.replace(/^最新(?:的)?|最新(?:的)?$/g, ''))
    .filter(token => token && !/^(latest|newest)$/i.test(token)))].sort();
  const dates = substantive.filter(token => /\d{4}(?:[-/.年]\d{1,2})?(?:[-/.月]\d{1,2}日?)?/.test(token));
  const entities = substantive.filter(token => /^["'“‘]/.test(token));
  return { substantive, dates, entities };
}

/** Word order outside quoted phrases is cosmetic; phrase boundaries and spaces remain significant. */
export function strategyKey(action: SearchAction): string {
  return JSON.stringify([parts(action).substantive, domains(action), action.freshness, language(action)]);
}

export function queryChange(previous: SearchAction, next: SearchAction): { meaningful: boolean; dimensions: Dimension[] } {
  const before = parts(previous), after = parts(next);
  const changed = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  const dimensions: Dimension[] = [];
  if (changed(before.entities, after.entities)) dimensions.push('entity');
  if (changed(before.substantive, after.substantive)) dimensions.push('wording');
  if (changed(domains(previous), domains(next))) dimensions.push('domain');
  if (previous.freshness !== next.freshness || changed(before.dates, after.dates)) dimensions.push('time');
  if (language(previous) !== language(next)) dimensions.push('language');
  return { meaningful: dimensions.length > 0, dimensions };
}
