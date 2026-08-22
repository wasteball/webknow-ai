import {
  BackgroundRequestSchema,
  FingerprintResultSchema,
  QuestionCommandSchema,
  type QuestionEvent,
} from '../src/contracts';
import { normalizeThrown, testModelConnection } from '../src/model';
import { runQuestion } from '../src/orchestrator';
import { clearSession, getSession, markSessionStale, saveSession } from '../src/storage';

const QUESTION_PORT = 'wka-question';

async function matchesCurrentPage(
  tabId: number,
  url: string,
  fingerprint: string,
): Promise<boolean> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.url !== url) return false;
    const current = FingerprintResultSchema.safeParse(
      await browser.tabs.sendMessage(tabId, {
        scope: 'wka-page',
        type: 'GET_FINGERPRINT',
      }),
    );
    return current.success && current.data.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

export default defineBackground(() => {
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

  browser.runtime.onMessage.addListener(async (raw) => {
    const parsed = BackgroundRequestSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    try {
      return { ok: true, capability: await testModelConnection() };
    } catch (error) {
      return { ok: false, error: normalizeThrown(error) };
    }
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== QUESTION_PORT) return;
    const runs = new Map<string, AbortController>();
    const post = (event: QuestionEvent) => {
      try {
        port.postMessage(event);
      } catch {
        // The panel is already closed; its disconnect handler aborts active runs.
      }
    };

    port.onMessage.addListener(async (raw) => {
      const parsed = QuestionCommandSchema.safeParse(raw);
      if (!parsed.success) return;
      const command = parsed.data;
      if (command.type === 'CANCEL') {
        runs.get(command.runId)?.abort();
        return;
      }
      if (runs.has(command.runId)) return;
      const controller = new AbortController();
      runs.set(command.runId, controller);
      try {
        const session = await getSession(command.tabId);
        if (!session || session.id !== command.sessionId) {
          post({
            type: 'FAILED',
            runId: command.runId,
            error: {
              code: 'STALE_SESSION',
              retryable: false,
              message: '当前标签页会话已经变化，请重新读取网页。',
            },
          });
          return;
        }
        if (!(await matchesCurrentPage(command.tabId, session.page.url, session.fingerprint))) {
          await markSessionStale(command.tabId, session.id);
          post({
            type: 'FAILED',
            runId: command.runId,
            error: {
              code: 'STALE_SESSION',
              retryable: true,
              message: '页面正文已经变化，请重新读取后再提问。',
            },
          });
          return;
        }
        const result = await runQuestion(
          command.runId,
          session,
          command.question,
          controller.signal,
          (state) => post({ type: 'STATE', runId: command.runId, state }),
        );
        if (controller.signal.aborted) {
          post({ type: 'CANCELLED', runId: command.runId });
          return;
        }
        const pageStillMatches = await matchesCurrentPage(
          command.tabId,
          session.page.url,
          session.fingerprint,
        );
        const currentSession = await getSession(command.tabId);
        if (!pageStillMatches || !currentSession || currentSession.id !== session.id) {
          if (!pageStillMatches) await markSessionStale(command.tabId, session.id);
          post({
            type: 'FAILED',
            runId: command.runId,
            error: {
              code: 'STALE_SESSION',
              retryable: true,
              message: '回答完成前页面内容或会话已经变化，旧结果未保存。',
            },
          });
          return;
        }
        if (controller.signal.aborted) {
          post({ type: 'CANCELLED', runId: command.runId });
          return;
        }
        await saveSession({ ...currentSession, latestAnswer: result, updatedAt: Date.now() });
        if (controller.signal.aborted) {
          const saved = await getSession(command.tabId);
          if (saved?.id === session.id && saved.latestAnswer?.runId === command.runId) {
            const { latestAnswer: _discarded, ...withoutAnswer } = saved;
            await saveSession(withoutAnswer);
          }
          post({ type: 'CANCELLED', runId: command.runId });
          return;
        }
        post({ type: 'COMPLETED', runId: command.runId, result });
      } catch (error) {
        const normalized = normalizeThrown(error);
        post(
          normalized.code === 'CANCELLED'
            ? { type: 'CANCELLED', runId: command.runId }
            : { type: 'FAILED', runId: command.runId, error: normalized },
        );
      } finally {
        runs.delete(command.runId);
      }
    });

    port.onDisconnect.addListener(() => {
      for (const controller of runs.values()) controller.abort();
      runs.clear();
    });
  });

  browser.tabs.onUpdated.addListener(async (tabId, change, tab) => {
    if (!change.url) return;
    const session = await getSession(tabId);
    if (session && tab.url !== session.page.url) await markSessionStale(tabId);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void clearSession(tabId);
  });
});
