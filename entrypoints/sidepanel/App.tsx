import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  type AnswerResult,
  CaptureResultSchema,
  type DocumentSession,
  type EvidenceBlock,
  FingerprintResultSchema,
  JumpResultSchema,
  type ModelCapability,
  type NormalizedError,
  type PageContext,
  QuestionEventSchema,
} from '../../src/contracts';
import { MODEL_HOST_PERMISSION } from '../../src/provider';
import {
  clearModelConfig,
  clearSession,
  confirmRecipient,
  getSession,
  markSessionStale,
  modelStatus,
  saveModelConfig,
  saveSession,
} from '../../src/storage';

type PanelStage =
  | 'LOADING'
  | 'UNSUPPORTED'
  | 'PERMISSION_REQUIRED'
  | 'IDLE'
  | 'PARSING'
  | 'READY'
  | 'RUNNING'
  | 'ERROR';

type State = {
  stage: PanelStage;
  page?: PageContext;
  session?: DocumentSession;
  result?: AnswerResult;
  runState?: 'PREPARING' | 'SYNTHESIZING' | 'VERIFYING';
  error?: NormalizedError;
  jumpMessage?: string;
};

type Action =
  | { type: 'PAGE'; page: PageContext; stage: PanelStage; session?: DocumentSession }
  | { type: 'PARSING' }
  | { type: 'CAPTURED'; session: DocumentSession }
  | { type: 'RUNNING'; runState: State['runState'] }
  | { type: 'RESULT'; result: AnswerResult }
  | { type: 'ERROR'; error: NormalizedError; stage?: PanelStage }
  | { type: 'JUMP'; message: string }
  | { type: 'RESET' };

const initialState: State = { stage: 'LOADING' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'PAGE':
      return {
        stage: action.stage,
        page: action.page,
        ...(action.session ? { session: action.session, result: action.session.latestAnswer } : {}),
      };
    case 'PARSING':
      return { stage: 'PARSING', page: state.page };
    case 'CAPTURED':
      return {
        ...state,
        stage: 'READY',
        session: action.session,
        result: undefined,
        error: undefined,
      };
    case 'RUNNING':
      return { ...state, stage: 'RUNNING', runState: action.runState, error: undefined };
    case 'RESULT':
      return { ...state, stage: 'READY', result: action.result, runState: undefined };
    case 'ERROR': {
      const stale = action.error.code === 'STALE_SESSION';
      return {
        ...state,
        stage: action.stage ?? 'ERROR',
        error: action.error,
        runState: undefined,
        ...(stale
          ? {
              result: undefined,
              session: state.session
                ? { ...state.session, state: 'STALE' as const, latestAnswer: undefined }
                : undefined,
            }
          : {}),
      };
    }
    case 'JUMP':
      return { ...state, jumpMessage: action.message };
    case 'RESET':
      return initialState;
  }
}

function originPattern(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? `${parsed.origin}/*` : undefined;
  } catch {
    return undefined;
  }
}

async function requestHostPermission(pattern: string): Promise<boolean> {
  return import.meta.env.MODE === 'test'
    ? browser.permissions.contains({ origins: [pattern] })
    : browser.permissions.request({ origins: [pattern] });
}

function pageFromTab(tab: { id?: number; url?: string; title?: string }): PageContext | undefined {
  if (tab.id === undefined || !tab.url) return undefined;
  const pattern = originPattern(tab.url);
  if (!pattern) {
    return {
      tabId: tab.id,
      url: 'https://unsupported.invalid/',
      origin: '',
      title: tab.title ?? '',
      kind: 'unsupported',
    };
  }
  const url = new URL(tab.url);
  return {
    tabId: tab.id,
    url: tab.url,
    origin: url.origin,
    title: tab.title ?? url.hostname,
    kind: 'html',
  };
}

function normalizedInternal(message: string): NormalizedError {
  return { code: 'INTERNAL', retryable: false, message };
}

async function activeTab() {
  if (import.meta.env.MODE === 'test') {
    const tabId = Number(new URLSearchParams(location.search).get('tabId'));
    if (Number.isInteger(tabId) && tabId >= 0) return browser.tabs.get(tabId);
  }
  return (await browser.tabs.query({ active: true, currentWindow: true }))[0];
}

function stageLabel(state: State): string {
  if (state.stage === 'RUNNING') {
    return {
      PREPARING: '正在预检',
      SYNTHESIZING: '正在整理主张',
      VERIFYING: '正在复核引用',
    }[state.runState ?? 'PREPARING'];
  }
  return {
    LOADING: '正在识别页面',
    UNSUPPORTED: '当前页面不支持',
    PERMISSION_REQUIRED: '等待站点授权',
    IDLE: '可以读取网页',
    PARSING: '正在建立证据索引',
    READY: state.session?.state === 'READY_PARTIAL' ? '已读取 · 部分模态未解析' : '已读取',
    ERROR: '需要处理',
  }[state.stage];
}

function relationLabel(relation: string): string {
  const labels: Record<string, string> = {
    supports: '支持',
    opposes: '反对',
    limits: '限制',
    context: '背景',
  };
  return labels[relation] ?? relation;
}

function statusLabel(status: AnswerResult['status']): string {
  return {
    SUPPORTED: '证据支持',
    PARTIALLY_SUPPORTED: '部分支持',
    CONFLICTED: '证据冲突',
    INSUFFICIENT: '证据不足',
    DEGRADED: '降级完成',
  }[status];
}

function recipientNotice() {
  return (
    <div className="receiver-copy">
      <p>
        <strong>接收方：</strong>DeepSeek API（api.deepseek.com）
      </p>
      <p>
        <strong>将发送：</strong>你的问题、当前网页中全部可引用文本块，以及第二轮证据复核数据。
      </p>
      <ul>
        <li>调用费用由你的 DeepSeek 账号承担。</li>
        <li>本产品后端不代理请求，不代表 DeepSeek 不记录或留存数据。</li>
        <li>请确认你有权把当前资料发送给该服务。</li>
      </ul>
    </div>
  );
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [model, setModel] = useState('deepseek-chat');
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [capability, setCapability] = useState<ModelCapability>();
  const [settingsMessage, setSettingsMessage] = useState('');
  const [question, setQuestion] = useState('');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [confirmationChecked, setConfirmationChecked] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState('');
  const portRef = useRef<ReturnType<typeof browser.runtime.connect> | undefined>(undefined);
  const runIdRef = useRef<string | undefined>(undefined);

  const refreshModelStatus = useCallback(async () => {
    const status = await modelStatus();
    setModel(status.profile.model);
    setConfigured(status.profile.configured);
    setCapability(status.capability);
  }, []);

  const refreshPage = useCallback(async () => {
    dispatch({ type: 'RESET' });
    const tab = await activeTab();
    const page = tab ? pageFromTab(tab) : undefined;
    if (!page || page.kind === 'unsupported') {
      dispatch({
        type: 'PAGE',
        page: page ?? {
          tabId: 0,
          url: 'https://unsupported.invalid/',
          origin: '',
          title: '',
          kind: 'unsupported',
        },
        stage: 'UNSUPPORTED',
      });
      return;
    }
    const session = await getSession(page.tabId);
    if (session?.page.url === page.url && session.state !== 'STALE') {
      dispatch({ type: 'PAGE', page, stage: 'READY', session });
      return;
    }
    const pattern = originPattern(page.url);
    const granted = pattern ? await browser.permissions.contains({ origins: [pattern] }) : false;
    dispatch({ type: 'PAGE', page, stage: granted ? 'IDLE' : 'PERMISSION_REQUIRED' });
  }, []);

  useEffect(() => {
    void refreshModelStatus();
    void refreshPage();
    const onActivated = () => void refreshPage();
    const onUpdated = (_tabId: number, change: { url?: string }) => {
      if (change.url) void refreshPage();
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      portRef.current?.disconnect();
    };
  }, [refreshModelStatus, refreshPage]);

  async function grantAndCapture() {
    const page = state.page;
    if (page?.kind !== 'html') return;
    try {
      const pattern = originPattern(page.url);
      if (!pattern) return;
      const granted = await requestHostPermission(pattern);
      if (!granted) {
        dispatch({
          type: 'ERROR',
          stage: 'PERMISSION_REQUIRED',
          error: {
            code: 'PERMISSION_REQUIRED',
            retryable: true,
            message: `未获得 ${page.origin} 的读取权限。`,
          },
        });
        return;
      }
      dispatch({ type: 'PARSING' });
      await clearSession(page.tabId);
      const sessionId = crypto.randomUUID();
      await browser.scripting.executeScript({
        target: { tabId: page.tabId },
        files: ['/page-agent.js'],
      });
      const raw = await browser.tabs.sendMessage(page.tabId, {
        scope: 'wka-page',
        type: 'CAPTURE',
        sessionId,
      });
      const parsed = CaptureResultSchema.safeParse(raw);
      if (!parsed.success) {
        dispatch({ type: 'ERROR', error: normalizedInternal('页面脚本返回了无法识别的结果。') });
        return;
      }
      if (!parsed.data.ok) {
        dispatch({ type: 'ERROR', error: parsed.data.error });
        return;
      }
      const now = Date.now();
      const session: DocumentSession = {
        id: sessionId,
        tabId: page.tabId,
        state: parsed.data.state,
        page: {
          ...page,
          title: parsed.data.title,
          url: parsed.data.url,
          origin: new URL(parsed.data.url).origin,
        },
        fingerprint: parsed.data.fingerprint,
        blocks: parsed.data.blocks,
        completeness: parsed.data.completeness,
        createdAt: now,
        updatedAt: now,
      };
      await saveSession(session);
      dispatch({ type: 'CAPTURED', session });
    } catch {
      dispatch({
        type: 'ERROR',
        error: normalizedInternal('无法读取此页面。请确认页面允许扩展脚本运行，然后重试。'),
      });
    }
  }

  async function saveSettings() {
    if (!apiKey.trim() || !model.trim()) {
      setSettingsMessage('请填写模型名和 API Key。');
      return;
    }
    try {
      await saveModelConfig(model, apiKey);
      setApiKey('');
      setConfigured(true);
      setCapability(undefined);
      setSettingsMessage('配置已保存在扩展本地存储；更换配置后需重新测试和确认接收方。');
    } catch {
      setSettingsMessage('配置格式无效；模型名最多 100 字符，API Key 最多 500 字符。');
    }
  }

  async function testConnection() {
    setCapability(undefined);
    setSettingsMessage('正在测试 DeepSeek 直连与 JSON 模式…');
    try {
      const granted = await requestHostPermission(MODEL_HOST_PERMISSION);
      if (!granted) {
        setSettingsMessage('未获得 DeepSeek API 的网络访问权限。');
        return;
      }
      const response = (await browser.runtime.sendMessage({
        scope: 'wka-background',
        type: 'TEST_MODEL',
      })) as { ok?: boolean; capability?: ModelCapability; error?: NormalizedError };
      if (response.ok && response.capability) {
        setCapability(response.capability);
        setSettingsMessage(response.capability.detail);
      } else {
        await refreshModelStatus();
        setSettingsMessage(response.error?.message ?? '连接测试失败。');
      }
    } catch {
      setSettingsMessage('无法申请模型网络权限或连接后台，请重试。');
    }
  }

  async function clearSettings() {
    await clearModelConfig();
    setConfigured(false);
    setCapability(undefined);
    setApiKey('');
    setSettingsMessage('模型凭证已清除；当前网页会话仍保留。');
  }

  function connectPort(): ReturnType<typeof browser.runtime.connect> {
    if (portRef.current) return portRef.current;
    const port = browser.runtime.connect({ name: 'wka-question' });
    port.onMessage.addListener((raw) => {
      const parsed = QuestionEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.runId !== runIdRef.current) return;
      const event = parsed.data;
      if (event.type === 'STATE') dispatch({ type: 'RUNNING', runState: event.state });
      if (event.type === 'COMPLETED') {
        dispatch({ type: 'RESULT', result: event.result });
        runIdRef.current = undefined;
      }
      if (event.type === 'FAILED') {
        dispatch({ type: 'ERROR', error: event.error });
        runIdRef.current = undefined;
      }
      if (event.type === 'CANCELLED') {
        dispatch({
          type: 'ERROR',
          stage: 'READY',
          error: {
            code: 'CANCELLED',
            retryable: true,
            message: '已停止本次处理；停止不能撤回已经发送到接收方的内容。',
          },
        });
        runIdRef.current = undefined;
      }
    });
    port.onDisconnect.addListener(() => {
      portRef.current = undefined;
      if (runIdRef.current) {
        runIdRef.current = undefined;
        dispatch({
          type: 'ERROR',
          stage: 'READY',
          error: {
            code: 'INTERNAL',
            retryable: true,
            message: '后台连接已中断，本次回答未完成。',
          },
        });
      }
    });
    portRef.current = port;
    return port;
  }

  async function submitQuestion(value = question) {
    const clean = value.trim();
    if (!clean || !state.session || !state.page) return;
    if (clean.length > 4000) {
      dispatch({
        type: 'ERROR',
        stage: 'READY',
        error: normalizedInternal('问题最多 4000 字符，请缩短后再发送。'),
      });
      return;
    }
    if (!configured || capability?.status !== 'passed') {
      setSettingsOpen(true);
      setSettingsMessage('提问前请保存配置并通过连接测试。');
      return;
    }
    if (!(await modelStatus()).recipientConfirmed) {
      setPendingQuestion(clean);
      setConfirmationChecked(false);
      setConfirmationOpen(true);
      return;
    }
    try {
      const current = FingerprintResultSchema.safeParse(
        await browser.tabs.sendMessage(state.page.tabId, {
          scope: 'wka-page',
          type: 'GET_FINGERPRINT',
        }),
      );
      if (!current.success || current.data.fingerprint !== state.session.fingerprint) {
        await markSessionStale(state.page.tabId, state.session.id).catch(() => undefined);
        dispatch({
          type: 'ERROR',
          error: {
            code: 'STALE_SESSION',
            retryable: true,
            message: '页面正文已经变化，请重新读取后再提问。',
          },
        });
        return;
      }
    } catch {
      await markSessionStale(state.page.tabId, state.session.id).catch(() => undefined);
      dispatch({
        type: 'ERROR',
        error: {
          code: 'STALE_SESSION',
          retryable: true,
          message: '无法核对当前网页，请重新读取后再提问。',
        },
      });
      return;
    }
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    dispatch({ type: 'RUNNING', runState: 'PREPARING' });
    connectPort().postMessage({
      type: 'ASK',
      runId,
      tabId: state.page.tabId,
      sessionId: state.session.id,
      question: clean,
    });
  }

  async function acceptRecipient() {
    try {
      await confirmRecipient();
      setConfirmationOpen(false);
      const value = pendingQuestion;
      setPendingQuestion('');
      await submitQuestion(value);
    } catch {
      setConfirmationOpen(false);
      dispatch({
        type: 'ERROR',
        stage: 'READY',
        error: normalizedInternal('无法保存接收方确认，请重新配置模型。'),
      });
    }
  }

  function stopRun() {
    const runId = runIdRef.current;
    if (runId) portRef.current?.postMessage({ type: 'CANCEL', runId });
  }

  async function jump(block: EvidenceBlock) {
    if (!state.page) return;
    try {
      const raw = await browser.tabs.sendMessage(state.page.tabId, {
        scope: 'wka-page',
        type: 'JUMP',
        anchor: block.anchor,
      });
      const parsed = JumpResultSchema.safeParse(raw);
      if (!parsed.success || parsed.data.outcome === 'failed') {
        dispatch({
          type: 'JUMP',
          message: parsed.success ? (parsed.data.reason ?? '原位置已变化。') : '无法确认跳转结果。',
        });
        return;
      }
      dispatch({
        type: 'JUMP',
        message:
          parsed.data.outcome === 'jumped'
            ? '已跳到原文并高亮。'
            : '页面位置有变化，已通过唯一原文重新定位。',
      });
    } catch {
      dispatch({ type: 'JUMP', message: '页面脚本已失效，请重新读取网页。' });
    }
  }

  async function revokeSiteAccess() {
    const pattern = state.page ? originPattern(state.page.url) : undefined;
    if (!pattern || !state.page) return;
    try {
      await browser.permissions.remove({ origins: [pattern] });
      await clearSession(state.page.tabId);
      await refreshPage();
    } catch {
      dispatch({
        type: 'ERROR',
        stage: 'READY',
        error: normalizedInternal('无法撤销当前站点权限。'),
      });
    }
  }

  const blocks = new Map<string, EvidenceBlock>(
    state.result?.evidence.map((block) => [block.id, block] as const),
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">WEB KNOWLEDGE ASSISTANT</p>
          <h1>网页知识助手</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          aria-controls="settings"
        >
          <span>设置</span>
        </button>
      </header>

      {settingsOpen && (
        <section className="settings" id="settings" aria-label="模型设置">
          <div className="section-heading">
            <h2>DeepSeek 测试配置</h2>
            <span className="spike">SPIKE</span>
          </div>
          <p className="muted">固定连接 api.deepseek.com；真实测试通过前不视为已认证供应商。</p>
          <label>
            模型名
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={configured ? '输入新的 Key 以覆盖配置' : 'sk-…'}
              autoComplete="off"
            />
          </label>
          <div className="button-row">
            <button type="button" className="primary" onClick={() => void saveSettings()}>
              保存配置
            </button>
            <button type="button" disabled={!configured} onClick={() => void testConnection()}>
              测试连接
            </button>
            <button
              type="button"
              className="danger-link"
              disabled={!configured}
              onClick={() => void clearSettings()}
            >
              清除凭证
            </button>
          </div>
          {capability && (
            <p className={`inline-status ${capability.status}`}>
              {capability.status === 'passed' ? '✓' : '!'} {capability.detail}
            </p>
          )}
          {settingsMessage && (
            <p className="feedback" role="status">
              {settingsMessage}
            </p>
          )}
        </section>
      )}

      <section className="source-strip" aria-label="当前资料">
        <span className={`state-dot state-${state.stage.toLowerCase()}`} aria-hidden="true" />
        <div>
          <p className="source-label">当前资料</p>
          <h2>{state.page?.title || '正在识别…'}</h2>
          <p className="source-state">{stageLabel(state)}</p>
        </div>
        {state.session && (
          <div className="source-actions">
            <button
              type="button"
              className="text-button"
              disabled={state.stage === 'RUNNING'}
              onClick={() => void grantAndCapture()}
            >
              重新读取
            </button>
            <button
              type="button"
              className="text-button danger-link"
              disabled={state.stage === 'RUNNING'}
              onClick={() => void revokeSiteAccess()}
            >
              撤销站点
            </button>
          </div>
        )}
      </section>

      <main>
        {state.stage === 'UNSUPPORTED' && (
          <Empty
            title="此页面不能读取"
            body="浏览器内部页、扩展页和没有普通网页地址的标签页不支持注入。请打开一篇 HTML 文章。"
          />
        )}
        {state.stage === 'PERMISSION_REQUIRED' && (
          <Empty
            title="只读取你允许的网站"
            body={`当前需要 ${state.page?.origin || '此站点'} 的访问权限，不会默认读取其他网站。`}
            action="允许并读取"
            onAction={() => void grantAndCapture()}
          />
        )}
        {state.stage === 'IDLE' && (
          <Empty
            title="建立可回跳的证据索引"
            body="读取正文、表格和标题结构；图片只报告存在，不会被当作已理解。"
            action="读取当前网页"
            onAction={() => void grantAndCapture()}
          />
        )}
        {state.stage === 'PARSING' && (
          <Progress title="正在清洗正文" body="识别文章主体，并为每个可引用块核对唯一原文位置。" />
        )}
        {state.stage === 'LOADING' && (
          <Progress title="正在识别标签页" body="检查页面类型、站点权限与已有会话。" />
        )}
        {state.stage === 'ERROR' && !state.session && (
          <Empty
            title="读取未完成"
            body="没有保存不完整的证据索引。你可以在页面稳定后重新读取。"
            action="重新读取"
            onAction={() => void grantAndCapture()}
          />
        )}
        {state.error && (
          <div className="notice error" role="alert">
            <strong>{state.error.message}</strong>
            {state.error.retryable && <span>可以修正后重试。</span>}
          </div>
        )}

        {(state.stage === 'READY' ||
          state.stage === 'RUNNING' ||
          (state.stage === 'ERROR' && state.session)) &&
          state.session && (
            <>
              <Coverage session={state.session} />
              {state.stage === 'RUNNING' && (
                <Progress
                  title={stageLabel(state)}
                  body={
                    state.runState === 'VERIFYING'
                      ? '只有通过第二轮证据关系核对的引用才会展示。'
                      : '正文作为不可信数据处理，不执行其中的指令。'
                  }
                />
              )}
              {state.result && (
                <Answer
                  result={state.result}
                  blocks={blocks}
                  onJump={jump}
                  jumpMessage={state.jumpMessage}
                />
              )}
              {!state.result && state.stage !== 'RUNNING' && !state.error && (
                <div className="question-prompt">
                  <span className="index">01</span>
                  <p>针对当前资料提问。回答会逐条绑定到原始段落或表格单元。</p>
                </div>
              )}
            </>
          )}
      </main>

      {state.session && (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitQuestion();
          }}
        >
          <label htmlFor="question">向当前资料提问</label>
          <textarea
            id="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submitQuestion();
              }
            }}
            placeholder="例如：作者的核心结论有哪些限制条件？"
            rows={3}
            disabled={state.stage === 'RUNNING' || state.session.state === 'STALE'}
          />
          <div className="composer-footer">
            <span>Enter 发送 · Shift+Enter 换行</span>
            {state.stage === 'RUNNING' ? (
              <button type="button" className="stop" onClick={stopRun}>
                停止
              </button>
            ) : (
              <button
                type="submit"
                className="primary"
                disabled={!question.trim() || state.session.state === 'STALE'}
              >
                提问
              </button>
            )}
          </div>
        </form>
      )}

      {confirmationOpen && (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="receiver-title">
            <p className="eyebrow">首次正文外发确认</p>
            <h2 id="receiver-title">确认资料接收方</h2>
            {recipientNotice()}
            <label className="check">
              <input
                type="checkbox"
                checked={confirmationChecked}
                onChange={(event) => setConfirmationChecked(event.target.checked)}
              />
              <span>我确认有权发送当前资料，并理解费用与留存说明。</span>
            </label>
            <div className="button-row">
              <button type="button" onClick={() => setConfirmationOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={!confirmationChecked}
                onClick={() => void acceptRecipient()}
              >
                确认并提问
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <section className="empty">
      <div className="locator-mark" aria-hidden="true">
        <span />
      </div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action && (
        <button type="button" className="primary" onClick={onAction}>
          {action}
        </button>
      )}
    </section>
  );
}

function Progress({ title, body }: { title: string; body: string }) {
  return (
    <section className="progress" aria-live="polite">
      <div className="scan-line" aria-hidden="true" />
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
    </section>
  );
}

export function Coverage({ session }: { session: DocumentSession }) {
  const report = session.completeness;
  if (!report) return null;
  return (
    <section className="coverage">
      <div className="section-heading">
        <h2>资料覆盖</h2>
        <span>{session.blocks.length} 个证据块</span>
      </div>
      <div className="coverage-grid">
        <span>
          <b>
            {report.text.captured}/{report.text.found}
          </b>{' '}
          文本
        </span>
        <span>
          <b>
            {report.tables.captured}/{report.tables.found}
          </b>{' '}
          表格单元
        </span>
        <span className={report.images.status === 'unavailable' ? 'warn' : ''}>
          <b>{report.images.found}</b> 图片未解析
        </span>
      </div>
      {report.warnings.length > 0 && (
        <ul className="warnings">
          {report.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Answer({
  result,
  blocks,
  onJump,
  jumpMessage,
}: {
  result: AnswerResult;
  blocks: Map<string, EvidenceBlock>;
  onJump: (block: EvidenceBlock) => Promise<void>;
  jumpMessage?: string;
}) {
  return (
    <article className="answer">
      <header className={`answer-head status-${result.status.toLowerCase()}`}>
        <span className="verdict">{statusLabel(result.status)}</span>
        <h2>{result.conclusion}</h2>
        <p>
          核查范围：{result.coverage.sentBlocks}/{result.coverage.totalBlocks} 个可引用块
        </p>
      </header>
      <ol className="claims">
        {result.claims.map((claim, index) => (
          <li key={claim.id} className={`claim claim-${claim.status}`}>
            <div className="claim-number">{String(index + 1).padStart(2, '0')}</div>
            <div className="claim-body">
              <div className="claim-title">
                <h3>{claim.statement}</h3>
                <span>
                  {claim.status === 'supported'
                    ? '已核查'
                    : claim.status === 'conflicted'
                      ? '有冲突'
                      : '证据不足'}
                </span>
              </div>
              {claim.citations.map((citation) => {
                const block = blocks.get(citation.blockId);
                if (!block) return null;
                return (
                  <blockquote
                    key={`${claim.id}:${citation.blockId}:${citation.relation}`}
                    className={`evidence relation-${citation.relation}`}
                  >
                    <div className="evidence-meta">
                      <span>{relationLabel(citation.relation)}</span>
                      <span>
                        {block.sourceLevel} ·{' '}
                        {block.provenance.method === 'retained-anchor'
                          ? '原位锚点'
                          : '唯一文本重定位'}
                      </span>
                    </div>
                    <p>{block.content}</p>
                    {block.context.headingPath.length > 0 && (
                      <small>{block.context.headingPath.join(' › ')}</small>
                    )}
                    <button type="button" onClick={() => void onJump(block)}>
                      跳到原文
                    </button>
                  </blockquote>
                );
              })}
            </div>
          </li>
        ))}
      </ol>
      {result.unanswered.length > 0 && (
        <section className="unanswered">
          <h3>仍未回答</h3>
          <ul>
            {result.unanswered.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      {jumpMessage && (
        <p className="feedback" role="status">
          {jumpMessage}
        </p>
      )}
    </article>
  );
}
