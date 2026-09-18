import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';

import type { Command, PanelState, Reply } from '../core/protocol';
import { activeTabId, createClient, type Client } from './api';
import { Learning } from './components/Learning';
import { Reading } from './components/Reading';
import { Settings } from './components/Settings';
import { Setup } from './components/Setup';
import { Busy, ErrorBanner, Notice, ScopeLine, Section } from './components/bits';

const START_LABEL: Record<string, string> = {
  READY_TO_START: '开始伴读',
  STALE: '重新开始伴读',
};

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [state, setState] = useState<PanelState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const clientRef = useRef<Client | null>(null);

  useEffect(() => {
    const client = createClient({
      onState: setState,
      onProgress: (chars) => {
        setState((current) =>
          current?.busy ? { ...current, busy: { ...current.busy, chars } } : current,
        );
      },
    });
    clientRef.current = client;
    return () => client.dispose();
  }, []);

  useEffect(() => {
    const refresh = async () => setTabId(await activeTabId());
    void refresh();
    const onChange = () => void refresh();
    browser.tabs.onActivated.addListener(onChange);
    browser.tabs.onUpdated.addListener(onChange);
    return () => {
      browser.tabs.onActivated.removeListener(onChange);
      browser.tabs.onUpdated.removeListener(onChange);
    };
  }, []);

  useEffect(() => {
    if (tabId === null) return;
    void clientRef.current?.send({ type: 'attach', tabId });
  }, [tabId]);

  const send = useCallback(async (command: Command): Promise<Reply | undefined> => {
    const reply = await clientRef.current?.send(command);
    if (reply && !reply.ok) setNotice(reply.error.message);
    else if (reply?.message) setNotice(reply.message);
    return reply;
  }, []);

  /** 授权必须在用户手势里作为第一个异步调用发出，前面不能有 await（Chrome 侧栏约束）。 */
  const startReading = async () => {
    if (!state || state.tabId === null) return;
    const origin = state.pageUrl ? safeOrigin(state.pageUrl) : null;
    if (origin && state.permission !== 'granted') {
      try {
        const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
        if (!granted) {
          setNotice('没有授予当前站点权限，因此没有读取或外发任何正文。可以稍后再试。');
          return;
        }
      } catch {
        // 浏览器没有弹出授权窗口时（例如侧栏不在前台），给出下一步而不是静默失败。
        setNotice('浏览器没有弹出授权窗口。请点击工具栏图标重新打开侧栏，再点一次开始伴读。');
        return;
      }
    }
    await send({ type: 'start', tabId: state.tabId });
  };

  const phase = state?.phase ?? 'READY_TO_START';
  const busy = state?.busy ?? null;

  return (
    <div className="panel">
      <header className="panel-header">
        <h1>webknow-ai</h1>
        <button
          type="button"
          className="link"
          aria-expanded={showSettings}
          onClick={() => setShowSettings((value) => !value)}
        >
          {showSettings ? '返回阅读' : '设置'}
        </button>
      </header>

      {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}
      {state?.error && <ErrorBanner error={state.error} />}

      <p className="phase" role="status" aria-live="polite">
        {PHASE_TEXT[phase] ?? ''}
      </p>

      {showSettings ? (
        state && <Settings state={state} send={send} />
      ) : !state ? (
        <p className="hint">正在连接后台…</p>
      ) : (
        <>
          <div className="context">
            <p className="page-title">{state.pageTitle || '当前页面'}</p>
            <ScopeLine completeness={state.completeness} />
          </div>

          {phase === 'UNCONFIGURED' && <Setup state={state} send={send} />}

          {(phase === 'PERMISSION_REQUIRED' || phase === 'READY_TO_START' || phase === 'STALE') && (
            <Section title={phase === 'STALE' ? '页面已变化' : '准备伴读'}>
              {phase === 'PERMISSION_REQUIRED' && (
                <p>
                  需要读取当前页面的正文才能生成摘要与气泡。授权只针对
                  {state.pageUrl ? ` ${safeOrigin(state.pageUrl) ?? '当前站点'} ` : '当前站点'}，
                  不会读取其他网站。
                </p>
              )}
              {phase === 'STALE' && (
                <p>页面已经导航或正文发生变化，上一页的结果已作废，没有写入当前页面。</p>
              )}
              {!state.outboundConfirmed ? (
                <OutboundNotice
                  onConfirm={() => void send({ type: 'confirmOutbound' })}
                  confirmed={false}
                />
              ) : (
                <p className="hint">
                  已确认外发范围：正文与你的问题会发送给 DeepSeek，费用由你的账号承担。
                </p>
              )}
              <div className="composer-actions">
                <button
                  type="button"
                  disabled={!state.outboundConfirmed || busy !== null}
                  onClick={() => void startReading()}
                >
                  {START_LABEL[phase] ?? '开始伴读'}
                </button>
              </div>
            </Section>
          )}

          {phase === 'ANALYZING' && (
            <Busy
              label="正在提取正文并生成首屏"
              chars={busy?.chars ?? 0}
              onStop={() => state.tabId !== null && void send({ type: 'stop', tabId: state.tabId })}
            />
          )}

          {phase === 'ERROR' && (
            <Section title="重新开始">
              <p className="hint">
                上一页的首屏结果已经作废或生成失败。可以重新开始伴读，不会复用失败的结果。
              </p>
              <div className="composer-actions">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void startReading()}
                >
                  重新开始伴读
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null || state.tabId === null}
                  onClick={() => state.tabId !== null && void send({ type: 'clearSession', tabId: state.tabId })}
                >
                  清除当前页会话
                </button>
              </div>
            </Section>
          )}

          {phase === 'UNSUPPORTED' && (
            <Section title="当前页面不受支持">
              <p>{state.unsupportedReason}</p>
              <p className="hint">首版只支持公开、可提取连续正文的 HTML 文章页面。</p>
            </Section>
          )}

          {phase === 'READY' && (
            <>
              {state.learning?.status === 'closed' && <ClosedLearning state={state} />}
              <Reading state={state} send={send} />
            </>
          )}

          {phase === 'LEARNING' && <Learning state={state} send={send} />}
        </>
      )}
    </div>
  );
}

function ClosedLearning({ state }: { state: PanelState }) {
  const log = state.learning?.log ?? [];
  const summary = [...log].reverse().find((entry) => entry.role === 'summary');
  if (!summary) return null;
  return (
    <details className="section">
      <summary>上一轮学习收束</summary>
      <p className="summary">{summary.text}</p>
    </details>
  );
}

/** 首次外发前的告知与确认；接收方或范围变化后需要重新确认（FR-022）。 */
function OutboundNotice({ onConfirm, confirmed }: { onConfirm: () => void; confirmed: boolean }) {
  return (
    <div className="banner banner-info">
      <p>开始前请确认：</p>
      <ul>
        <li>接收方是 DeepSeek（深度求索），不是本站或本产品方。</li>
        <li>会发送当前页提取到的正文、你的问题以及必要的对话上下文。</li>
        <li>调用费用由你自己的 DeepSeek 账号承担；本产品没有代理后端，但这不等于 DeepSeek 不留存数据。</li>
        <li>请只在你确认页面公开、且自己有权这样处理时使用。</li>
      </ul>
      {!confirmed && (
        <button type="button" onClick={onConfirm}>
          我已了解并确认
        </button>
      )}
    </div>
  );
}

function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

const PHASE_TEXT: Record<string, string> = {
  UNCONFIGURED: '尚未配置 DeepSeek Key。',
  PERMISSION_REQUIRED: '等待授权读取当前页面。',
  READY_TO_START: '等待你点击开始伴读。',
  ANALYZING: '正在生成首屏。',
  READY: '首屏已就绪，可以探索或提问。',
  LEARNING: '正在进行“AI 问我”。',
  STALE: '页面已变化，旧结果已作废。',
  UNSUPPORTED: '当前页面不受支持。',
  ERROR: '上次操作没有完成。',
};
