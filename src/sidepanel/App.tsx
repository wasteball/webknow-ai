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
  STALE: '重新开始',
};

/**
 * 已就绪后的两个能力（问答 / AI 问我）用 Tab 切换：摘要固定在 Tab 之上，
 * 学习进行中也能随时切回问答（学习会话保留在后台，不因切换而中断）。
 */
type View = 'qa' | 'learn';

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [state, setState] = useState<PanelState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<View>('qa');
  const learningWasActive = useRef(false);
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

  // 学习会话从无到有（或重新激活）时自动切到“AI 问我”；其余时候尊重用户所在的 Tab。
  const learningActive = state?.learning?.status === 'active';
  useEffect(() => {
    if (learningActive && !learningWasActive.current) setView('learn');
    learningWasActive.current = learningActive;
  }, [learningActive]);

  const send = useCallback(async (command: Command): Promise<Reply | undefined> => {
    const reply = await clientRef.current?.send(command);
    if (reply && !reply.ok) setNotice(reply.error.message);
    else if (reply?.message) setNotice(reply.message);
    return reply;
  }, []);

  /**
   * 授权必须在用户手势里作为第一个异步调用发出，前面不能有 await（Chrome 侧栏约束）；
   * 因此外发确认与开始伴读合并成一个按钮时，顺序必须是：授权 → 记录确认 → 开始。
   *
   * 合并的原因：分成两个按钮时，“开始伴读”处于禁用状态且不说明原因，
   * 真实用户点了没反应，不知道要先点上面那个确认。
   */
  const startReading = async (options?: { confirm?: boolean }) => {
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
    if (options?.confirm) {
      const reply = await send({ type: 'confirmOutbound' });
      if (!reply?.ok) return;
    }
    await send({ type: 'start', tabId: state.tabId });
  };

  const phase = state?.phase ?? 'READY_TO_START';
  const busy = state?.busy ?? null;
  const readyShell = phase === 'READY' || phase === 'LEARNING';
  const phaseText = readyShell ? null : PHASE_TEXT[phase];

  return (
    <div
      className="panel"
      style={state?.settings.fontSize === 'large' ? { zoom: 1.15 } : undefined}
    >
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

      {showSettings ? (
        state && <Settings state={state} send={send} />
      ) : !state ? (
        <p className="hint">正在连接后台…</p>
      ) : (
        <>
          {(state.pageTitle || state.completeness) && (
            <div className="context">
              {state.pageTitle && <p className="page-title">{state.pageTitle}</p>}
              <ScopeLine completeness={state.completeness} />
            </div>
          )}

          {phaseText && (
            <p className="phase" role="status" aria-live="polite">
              {phaseText}
            </p>
          )}

          {phase === 'UNCONFIGURED' && <Setup state={state} send={send} />}

          {(phase === 'PERMISSION_REQUIRED' || phase === 'READY_TO_START' || phase === 'STALE') && (
            <Section title={phase === 'STALE' ? '页面换了' : '开始读这一页'}>
              {phase === 'PERMISSION_REQUIRED' &&
                (state.pageUrl ? (
                  <p>
                    要读这一页的文字才能给你摘要。接下来浏览器会弹窗问你是否允许——只针对
                    {` ${safeOrigin(state.pageUrl) ?? '这一个网站'} `}，其他网站读不到。
                  </p>
                ) : (
                  // 拿不到网址时给可执行的下一步：点工具栏图标会把当前页地址交给扩展。
                  <p>
                    还不知道你正在看哪个网站。请先点一下浏览器右上角的{' '}
                    <strong>webknow-ai 图标</strong>，再回来点下面的按钮。
                  </p>
                ))}
              {phase === 'STALE' && (
                <p>你已经换了页面（或者这一页的内容变了）。上一页的结果作废了，不会拿来充数。</p>
              )}
              {!state.outboundConfirmed ? (
                <OutboundNotice searchProviderName={state.settings.search.enabled ? state.settings.search.providerName : null} />
              ) : (
                <p className="hint">你已经确认过：正文和你的问题会发给 DeepSeek，费用从你的账号扣。</p>
              )}
              <div className="composer-actions">
                {/* 未确认时不做成禁用按钮：禁用而不说原因，用户会以为点了没反应。 */}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void startReading({ confirm: !state.outboundConfirmed })}
                >
                  {state.outboundConfirmed ? (START_LABEL[phase] ?? '开始伴读') : '我确认，开始伴读'}
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
            <Section title="重新试一次">
              <p className="hint">
                刚才那一步没成功，失败了的结果不会拿来充数。可以重新开始，页面内容还留着。
              </p>
              <div className="composer-actions">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void startReading({ confirm: !state.outboundConfirmed })}
                >
                  重新开始
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null || state.tabId === null}
                  onClick={() => state.tabId !== null && void send({ type: 'clearSession', tabId: state.tabId })}
                >
                  清掉这一页的内容
                </button>
              </div>
            </Section>
          )}

          {phase === 'UNSUPPORTED' && (
            <Section title="这一页读不了">
              <p>{state.unsupportedReason}</p>
              <p className="hint">目前只支持公开的文章类网页。列表页、搜索结果、要登录才能看的页面都不行。</p>
            </Section>
          )}

          {readyShell && (
            <>
              {state.guide && (
                <Section title="这篇文章讲了什么">
                  <p className="summary">{state.guide.summary}</p>
                  {state.guide.bubbles.length > 0 && (
                    <div className="bubbles">
                      {state.guide.bubbles.map((bubble) => (
                        <button
                          key={bubble.id}
                          type="button"
                          className="bubble"
                          disabled={busy !== null}
                          onClick={() => {
                            if (state.tabId) void send({ type: 'explore', tabId: state.tabId, bubbleId: bubble.id });
                          }}
                        >
                          {bubble.question}
                        </button>
                      ))}
                    </div>
                  )}
                </Section>
              )}

              <div className="tabs" role="tablist" aria-label="功能切换">
                <button
                  type="button"
                  role="tab"
                  className="tab"
                  aria-selected={view === 'qa'}
                  onClick={() => setView('qa')}
                >
                  问答
                  {busy?.kind === 'answer' && <span className="dot" aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  role="tab"
                  className="tab"
                  aria-selected={view === 'learn'}
                  onClick={() => setView('learn')}
                >
                  AI 问我
                  {busy?.kind === 'learn' && <span className="dot" aria-hidden="true" />}
                </button>
              </div>

              {view === 'qa' ? <Reading state={state} send={send} /> : <Learning state={state} send={send} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** 首次外发前的告知与确认；接收方或范围变化后需要重新确认（FR-022）。 */
function OutboundNotice({ searchProviderName }: { searchProviderName: string | null }) {
  return (
    <div className="banner banner-info">
      <p>开始之前，请先确认这几件事：</p>
      <ul>
        <li>你正在看的这一页的文字，会发给 DeepSeek 这家公司（不是发给我们）。</li>
        <li>发过去的是：这一页的正文、你提的问题，以及前面几轮对话。</li>
        {searchProviderName && (
          <li>
            你还启用了联网搜索（{searchProviderName}）：打开那个开关提问时，你的<strong>搜索词</strong>会发给它；
            文章正文不会发给它。
          </li>
        )}
        <li>费用从你自己的 DeepSeek 账号里扣。</li>
        <li>请只在这一页是公开的、你有权这样使用的时候才用。</li>
      </ul>
      <p className="hint">
        DeepSeek 收到内容后怎么保存，由它自己的规则决定，我们没法替你保证它不留存。
      </p>
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
  UNCONFIGURED: '还没有填 DeepSeek 钥匙。',
  PERMISSION_REQUIRED: '等你在浏览器里允许读取这个网站。',
  READY_TO_START: '准备好了。你点开始，我才读这一页。',
  ANALYZING: '正在读这一页，马上给你摘要。',
  STALE: '页面换了，之前的内容已经作废。',
  UNSUPPORTED: '这一页暂时读不了。',
  ERROR: '上一步没成功。',
};
