import {
  type DocumentSession,
  DocumentSessionSchema,
  type ModelCapability,
  ModelCapabilitySchema,
  type ModelProfile,
  ModelProfileSchema,
} from './contracts';

import { MODEL_SECRET_KEY, MODEL_STATUS_KEY, RECIPIENT_POLICY_VERSION } from './storage-keys';

const SESSION_PREFIX = 'session:';
const ENDPOINT = 'https://api.deepseek.com/chat/completions' as const;

type ModelSecret = { configId: string; model: string; apiKey: string };
type PublicModelStatus = {
  configId: string;
  profile: ModelProfile;
  capability?: ModelCapability;
  confirmation?: { configId: string; policyVersion: typeof RECIPIENT_POLICY_VERSION };
};

const fallbackProfile: ModelProfile = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  endpoint: ENDPOINT,
  configured: false,
};

function parseStatus(value: unknown): PublicModelStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<PublicModelStatus>;
  const profile = ModelProfileSchema.safeParse(candidate.profile);
  if (!profile.success || typeof candidate.configId !== 'string') return undefined;
  const status: PublicModelStatus = { configId: candidate.configId, profile: profile.data };
  const capability = ModelCapabilitySchema.safeParse(candidate.capability);
  if (capability.success) status.capability = capability.data;
  if (
    candidate.confirmation?.policyVersion === RECIPIENT_POLICY_VERSION &&
    typeof candidate.confirmation.configId === 'string'
  ) {
    status.confirmation = candidate.confirmation;
  }
  return status;
}

async function getPublicStatus(): Promise<PublicModelStatus | undefined> {
  const result = await browser.storage.local.get(MODEL_STATUS_KEY);
  return parseStatus(result[MODEL_STATUS_KEY]);
}

export async function saveModelConfig(model: string, apiKey: string): Promise<ModelProfile> {
  const cleanModel = model.trim();
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey.length > 500) throw new Error('Invalid API key length');
  const configId = crypto.randomUUID();
  const profile = ModelProfileSchema.parse({
    provider: 'deepseek',
    model: cleanModel,
    endpoint: ENDPOINT,
    configured: true,
  });
  const secret: ModelSecret = { configId, model: cleanModel, apiKey: cleanKey };
  const status: PublicModelStatus = { configId, profile };
  await browser.storage.local.set({ [MODEL_SECRET_KEY]: secret, [MODEL_STATUS_KEY]: status });
  return profile;
}

export async function modelStatus(): Promise<{
  profile: ModelProfile;
  capability?: ModelCapability;
  recipientConfirmed: boolean;
}> {
  const status = await getPublicStatus();
  if (!status) return { profile: fallbackProfile, recipientConfirmed: false };
  const result: {
    profile: ModelProfile;
    capability?: ModelCapability;
    recipientConfirmed: boolean;
  } = {
    profile: status.profile,
    recipientConfirmed:
      status.confirmation?.configId === status.configId &&
      status.confirmation.policyVersion === RECIPIENT_POLICY_VERSION,
  };
  if (status.capability) result.capability = status.capability;
  return result;
}

export async function saveModelCapability(
  capability: ModelCapability,
  expectedConfigId: string,
): Promise<void> {
  const status = await getPublicStatus();
  if (!status || status.configId !== expectedConfigId) return;
  status.capability = ModelCapabilitySchema.parse(capability);
  await browser.storage.local.set({ [MODEL_STATUS_KEY]: status });
}

export async function confirmRecipient(): Promise<void> {
  const status = await getPublicStatus();
  if (!status) throw new Error('Model is not configured');
  status.confirmation = { configId: status.configId, policyVersion: RECIPIENT_POLICY_VERSION };
  await browser.storage.local.set({ [MODEL_STATUS_KEY]: status });
}

export async function isRecipientConfirmed(): Promise<boolean> {
  return (await modelStatus()).recipientConfirmed;
}

export async function clearModelConfig(): Promise<void> {
  await browser.storage.local.remove([MODEL_SECRET_KEY, MODEL_STATUS_KEY]);
}

function sessionKey(tabId: number): string {
  return `${SESSION_PREFIX}${tabId}`;
}

export async function saveSession(session: DocumentSession): Promise<void> {
  const validated = DocumentSessionSchema.parse(session);
  await browser.storage.session.set({ [sessionKey(validated.tabId)]: validated });
}

export async function getSession(tabId: number): Promise<DocumentSession | undefined> {
  const key = sessionKey(tabId);
  const result = await browser.storage.session.get(key);
  const parsed = DocumentSessionSchema.safeParse(result[key]);
  return parsed.success ? parsed.data : undefined;
}

export async function clearSession(tabId: number): Promise<void> {
  await browser.storage.session.remove(sessionKey(tabId));
}

export async function clearAllSessions(): Promise<void> {
  const all = await browser.storage.session.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(SESSION_PREFIX));
  if (keys.length) await browser.storage.session.remove(keys);
}

export async function markSessionStale(
  tabId: number,
  expectedSessionId?: string,
): Promise<DocumentSession | undefined> {
  const session = await getSession(tabId);
  if (!session || (expectedSessionId && session.id !== expectedSessionId)) return session;
  const { latestAnswer: _discarded, ...current } = session;
  const stale: DocumentSession = { ...current, state: 'STALE', updatedAt: Date.now() };
  await saveSession(stale);
  return stale;
}
