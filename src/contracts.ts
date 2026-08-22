import { z } from 'zod';

export const DOCUMENT_STATES = [
  'UNSUPPORTED',
  'PERMISSION_REQUIRED',
  'IDLE',
  'PARSING',
  'READY_COMPLETE',
  'READY_PARTIAL',
  'PARSE_FAILED',
  'STALE',
] as const;
export const ANSWER_STATUSES = [
  'SUPPORTED',
  'PARTIALLY_SUPPORTED',
  'CONFLICTED',
  'INSUFFICIENT',
  'DEGRADED',
] as const;
export const RELATIONS = ['supports', 'opposes', 'limits', 'context'] as const;

export const PageContextSchema = z.object({
  tabId: z.number().int().nonnegative(),
  url: z.url(),
  origin: z.string().min(1),
  title: z.string(),
  kind: z.enum(['html', 'unsupported']),
});

export const DomAnchorSchema = z.object({
  sessionAnchorId: z.string().min(1),
  selector: z.string().min(1).optional(),
  exact: z.string().min(1),
  prefix: z.string(),
  suffix: z.string(),
  textPosition: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }),
  headingPath: z.array(z.string()),
  fingerprint: z.string().min(1),
});

const BlockContextSchema = z.object({
  headingPath: z.array(z.string()),
  table: z
    .object({
      caption: z.string().optional(),
      column: z.string().optional(),
      row: z.string().optional(),
    })
    .optional(),
});

export const EvidenceBlockSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    modality: z.enum(['text', 'table']),
    role: z.enum(['heading', 'paragraph', 'list-item', 'table-cell']),
    content: z.string().min(1),
    context: BlockContextSchema,
    source: z.object({ url: z.url(), title: z.string() }),
    anchor: DomAnchorSchema,
    provenance: z.object({
      parser: z.literal('readability'),
      method: z.enum(['retained-anchor', 'unique-text']),
    }),
    integrity: z.object({
      fingerprint: z.string().min(1),
      completeness: z.enum(['complete', 'partial']),
    }),
    sourceLevel: z.literal('L1'),
  })
  .superRefine((block, context) => {
    if (block.content !== block.anchor.exact) {
      context.addIssue({
        code: 'custom',
        path: ['anchor', 'exact'],
        message: 'Anchor text differs from evidence content',
      });
    }
    if (block.anchor.fingerprint !== block.integrity.fingerprint) {
      context.addIssue({
        code: 'custom',
        path: ['integrity', 'fingerprint'],
        message: 'Evidence fingerprints differ',
      });
    }
  });

const ModalityReportSchema = z.object({
  status: z.enum(['parsed', 'partial', 'unavailable', 'not-present']),
  found: z.number().int().nonnegative(),
  captured: z.number().int().nonnegative(),
  note: z.string().optional(),
});

export const CompletenessReportSchema = z
  .object({
    scope: z.literal('readability-article'),
    text: ModalityReportSchema,
    tables: ModalityReportSchema,
    images: ModalityReportSchema,
    excludedAmbiguousBlocks: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .superRefine((report, context) => {
    (['text', 'tables', 'images'] as const).forEach((modality) => {
      if (report[modality].captured > report[modality].found) {
        context.addIssue({
          code: 'custom',
          path: [modality, 'captured'],
          message: 'Captured count exceeds found count',
        });
      }
    });
  });

export const CitationSchema = z.object({
  blockId: z.string().min(1),
  relation: z.enum(RELATIONS),
});

export const EvidenceClaimSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  importance: z.enum(['key', 'context']),
  status: z.enum(['supported', 'insufficient', 'conflicted']),
  citations: z.array(CitationSchema),
});

export const AnswerResultSchema = z
  .object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    question: z.string().min(1),
    status: z.enum(ANSWER_STATUSES),
    conclusion: z.string(),
    claims: z.array(EvidenceClaimSchema),
    evidence: z.array(EvidenceBlockSchema),
    unanswered: z.array(z.string()),
    coverage: z.object({
      sentBlocks: z.number().int().nonnegative(),
      totalBlocks: z.number().int().nonnegative(),
    }),
    completeness: CompletenessReportSchema,
  })
  .superRefine((answer, context) => {
    const evidenceIds = new Set(answer.evidence.map((block) => block.id));
    answer.evidence.forEach((block, index) => {
      if (block.sessionId !== answer.sessionId) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', index, 'sessionId'],
          message: 'Evidence belongs to another session',
        });
      }
    });
    answer.claims.forEach((claim, claimIndex) => {
      const relations = new Set(claim.citations.map((citation) => citation.relation));
      const expectedStatus = relations.has('supports')
        ? relations.has('opposes')
          ? 'conflicted'
          : 'supported'
        : 'insufficient';
      if (claim.status !== expectedStatus) {
        context.addIssue({
          code: 'custom',
          path: ['claims', claimIndex, 'status'],
          message: 'Claim status does not match verified citation relations',
        });
      }
      claim.citations.forEach((citation, citationIndex) => {
        if (!evidenceIds.has(citation.blockId)) {
          context.addIssue({
            code: 'custom',
            path: ['claims', claimIndex, 'citations', citationIndex, 'blockId'],
            message: 'Citation has no local evidence block',
          });
        }
      });
    });
    const keyClaims = answer.claims.filter((claim) => claim.importance === 'key');
    const expectedAnswerStatus =
      !keyClaims.length || keyClaims.every((claim) => claim.status === 'insufficient')
        ? 'INSUFFICIENT'
        : keyClaims.some((claim) => claim.status === 'conflicted')
          ? 'CONFLICTED'
          : keyClaims.some((claim) => claim.status === 'insufficient')
            ? 'PARTIALLY_SUPPORTED'
            : 'SUPPORTED';
    if (answer.status !== expectedAnswerStatus && answer.status !== 'DEGRADED') {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Answer status does not match key claims',
      });
    }
  });

export const DocumentSessionSchema = z
  .object({
    id: z.string().min(1),
    tabId: z.number().int().nonnegative(),
    state: z.enum(DOCUMENT_STATES),
    page: PageContextSchema,
    fingerprint: z.string(),
    blocks: z.array(EvidenceBlockSchema),
    completeness: CompletenessReportSchema.optional(),
    latestAnswer: AnswerResultSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .superRefine((session, context) => {
    if (
      (session.state === 'READY_COMPLETE' || session.state === 'READY_PARTIAL') &&
      (!session.blocks.length || !session.completeness)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Ready session has no evidence',
      });
    }
    session.blocks.forEach((block, index) => {
      if (block.sessionId !== session.id) {
        context.addIssue({
          code: 'custom',
          path: ['blocks', index, 'sessionId'],
          message: 'Evidence block belongs to another session',
        });
      }
    });
    if (session.latestAnswer && session.latestAnswer.sessionId !== session.id) {
      context.addIssue({
        code: 'custom',
        path: ['latestAnswer', 'sessionId'],
        message: 'Answer belongs to another session',
      });
    }
  });

export const ModelProfileSchema = z.object({
  provider: z.literal('deepseek'),
  model: z.string().trim().min(1).max(100),
  endpoint: z.literal('https://api.deepseek.com/chat/completions'),
  configured: z.boolean(),
});

export const ModelCapabilitySchema = z.object({
  testedAt: z.number().int().nonnegative(),
  model: z.string(),
  directConnection: z.boolean(),
  jsonMode: z.boolean(),
  status: z.enum(['passed', 'failed']),
  detail: z.string(),
});

export const NormalizedErrorSchema = z.object({
  code: z.enum([
    'PERMISSION_REQUIRED',
    'NOT_CONFIGURED',
    'AUTH',
    'MODEL_NOT_FOUND',
    'RATE_LIMITED',
    'BALANCE_INSUFFICIENT',
    'TIMEOUT',
    'NETWORK',
    'INVALID_RESPONSE',
    'CONTENT_TOO_LARGE',
    'PARSE_FAILED',
    'STALE_SESSION',
    'CANCELLED',
    'INTERNAL',
  ]),
  retryable: z.boolean(),
  message: z.string(),
});

export const PageRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      scope: z.literal('wka-page'),
      type: z.literal('CAPTURE'),
      sessionId: z.string().min(1),
    })
    .strict(),
  z.object({ scope: z.literal('wka-page'), type: z.literal('GET_FINGERPRINT') }).strict(),
  z
    .object({ scope: z.literal('wka-page'), type: z.literal('JUMP'), anchor: DomAnchorSchema })
    .strict(),
  z.object({ scope: z.literal('wka-page'), type: z.literal('DISPOSE_HIGHLIGHT') }).strict(),
]);

export const CaptureResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      title: z.string(),
      url: z.url(),
      fingerprint: z.string(),
      state: z.enum(['READY_COMPLETE', 'READY_PARTIAL']),
      blocks: z.array(EvidenceBlockSchema),
      completeness: CompletenessReportSchema,
    })
    .strict(),
  z.object({ ok: z.literal(false), error: NormalizedErrorSchema }).strict(),
]);

export const JumpResultSchema = z
  .object({
    outcome: z.enum(['jumped', 'relocated', 'failed']),
    reason: z.string().optional(),
  })
  .strict();

export const FingerprintResultSchema = z.object({ fingerprint: z.string().min(1) }).strict();

export const BackgroundRequestSchema = z
  .object({
    scope: z.literal('wka-background'),
    type: z.literal('TEST_MODEL'),
  })
  .strict();

export const QuestionCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ASK'),
      runId: z.string().min(1),
      tabId: z.number().int().nonnegative(),
      sessionId: z.string().min(1),
      question: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z.object({ type: z.literal('CANCEL'), runId: z.string().min(1) }).strict(),
]);

export const QuestionEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('STATE'),
      runId: z.string(),
      state: z.enum(['PREPARING', 'SYNTHESIZING', 'VERIFYING']),
    })
    .strict(),
  z
    .object({ type: z.literal('COMPLETED'), runId: z.string(), result: AnswerResultSchema })
    .strict(),
  z.object({ type: z.literal('FAILED'), runId: z.string(), error: NormalizedErrorSchema }).strict(),
  z.object({ type: z.literal('CANCELLED'), runId: z.string() }).strict(),
]);

export type PageContext = z.infer<typeof PageContextSchema>;
export type DomAnchor = z.infer<typeof DomAnchorSchema>;
export type EvidenceBlock = z.infer<typeof EvidenceBlockSchema>;
export type CompletenessReport = z.infer<typeof CompletenessReportSchema>;
export type EvidenceClaim = z.infer<typeof EvidenceClaimSchema>;
export type AnswerResult = z.infer<typeof AnswerResultSchema>;
export type DocumentSession = z.infer<typeof DocumentSessionSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;
export type NormalizedError = z.infer<typeof NormalizedErrorSchema>;
export type PageRequest = z.infer<typeof PageRequestSchema>;
export type CaptureResult = z.infer<typeof CaptureResultSchema>;
export type JumpResult = z.infer<typeof JumpResultSchema>;
export type FingerprintResult = z.infer<typeof FingerprintResultSchema>;
export type BackgroundRequest = z.infer<typeof BackgroundRequestSchema>;
export type QuestionCommand = z.infer<typeof QuestionCommandSchema>;
export type QuestionEvent = z.infer<typeof QuestionEventSchema>;
