import { ModelCapabilitySchema } from './contracts';
import { MODEL_SECRET_KEY, MODEL_STATUS_KEY, RECIPIENT_POLICY_VERSION } from './storage-keys';

export type ModelCredentials = { configId: string; model: string; apiKey: string };

type ApprovalState = {
  credentials?: ModelCredentials;
  tested: boolean;
  confirmed: boolean;
};

function parseCredentials(value: unknown): ModelCredentials | undefined {
  const candidate = value as { configId?: unknown; model?: unknown; apiKey?: unknown } | undefined;
  return candidate &&
    typeof candidate.configId === 'string' &&
    typeof candidate.model === 'string' &&
    typeof candidate.apiKey === 'string' &&
    candidate.apiKey.length > 0 &&
    candidate.apiKey.length <= 500
    ? {
        configId: candidate.configId,
        model: candidate.model,
        apiKey: candidate.apiKey,
      }
    : undefined;
}

export async function modelCredentials(): Promise<ModelCredentials | undefined> {
  const result = await browser.storage.local.get(MODEL_SECRET_KEY);
  return parseCredentials(result[MODEL_SECRET_KEY]);
}

export async function modelApprovalState(): Promise<ApprovalState> {
  const result = await browser.storage.local.get([MODEL_SECRET_KEY, MODEL_STATUS_KEY]);
  const credentials = parseCredentials(result[MODEL_SECRET_KEY]);
  if (!credentials) return { tested: false, confirmed: false };

  const status = result[MODEL_STATUS_KEY] as
    | {
        configId?: unknown;
        capability?: unknown;
        confirmation?: { configId?: unknown; policyVersion?: unknown };
      }
    | undefined;
  if (status?.configId !== credentials.configId) {
    return { credentials, tested: false, confirmed: false };
  }
  const capability = ModelCapabilitySchema.safeParse(status.capability);
  return {
    credentials,
    tested:
      capability.success &&
      capability.data.status === 'passed' &&
      capability.data.model === credentials.model,
    confirmed:
      status.confirmation?.configId === credentials.configId &&
      status.confirmation.policyVersion === RECIPIENT_POLICY_VERSION,
  };
}
