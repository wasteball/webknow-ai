import { z } from 'zod';
import { LIMITS } from '../limits';
import { AGENT_LIMITS } from './agent-limits';
import type { AgentAction } from './agent-types';

const controlChars = /[\u0000-\u001f\u007f-\u009f]/;
const text = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0);
const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const sourceId = id.regex(/^sr_[a-zA-Z0-9_-]+$/);
// Hostnames only: no scheme, credentials, port, path, query or fragment.
const hostname = z.string().min(1).max(253).regex(
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
);
const sourceIds = (min: number) => z.array(sourceId)
  .transform((ids) => [...new Set(ids)])
  .pipe(z.array(sourceId).min(min).max(AGENT_LIMITS.sourceReads));

/** Structural validation only; ledger/block membership is checked for the current run. */
export const AgentActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('search_web'),
    query: text(200).refine((value) => !controlChars.test(value)),
    purpose: z.enum(['latest', 'fact_check', 'compare', 'background', 'article_gap']),
    freshness: z.enum(['live', 'day', 'week', 'month', 'any']),
    language: text(40).refine((value) => !controlChars.test(value)),
    domains: z.array(hostname).max(5),
    maxResults: z.number().int().min(1).max(10),
  }).strict(),
  z.object({
    type: z.literal('read_sources'), sourceIds: sourceIds(1), focus: text(500),
  }).strict(),
  z.object({
    type: z.literal('ask_user'), question: text(500),
    reason: z.enum(['ambiguous_entity', 'permission', 'conflict']),
  }).strict(),
  z.object({
    type: z.literal('finish_answer'), answer: text(8_000),
    source: z.enum(['original', 'extended', 'unknown']),
    citations: z.array(id).max(LIMITS.maxBlocks), references: sourceIds(0),
    unanswered: z.array(text(500)).max(20),
    freshness: z.enum(['verified', 'date_unknown', 'stale', 'not_applicable']),
  }).strict(),
]) satisfies z.ZodType<AgentAction>;
