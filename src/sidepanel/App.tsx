import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { browser } from 'wxt/browser';

import { findProvider } from '../core/model-providers';
import type { Command, PanelState, Reply } from '../core/protocol';
import { activeTabId, createClient, openSettingsTab, type Client } from './api';
import { Learning } from './components/Learning';
import { Reading } from './components/Reading';
import { Setup } from './components/Setup';
import { Busy, Drafting, ErrorBanner, Notice, ScopeLine, Section } from './components/bits';
import { BrandMark, Icon } from './components/Icon';
import { outboundReceiverLines, outboundConfirmedHint, outboundFeeLine, outboundRetentionLine } from './outbound-copy';
import { needsPageHost, type PageEntryId } from './page-entry';
import { PageEntry } from './components/PageEntry';

/**
 * 已就绪后的两个能力用文字标签切换：「问 AI」是摘要 + 话题 + 自己提问，
 * 「AI 问」是它反过来考你。进行中也能随时切回（会话留在后台，不因切换而中断）；
 * 两个面板都保持挂载，所以切回来时草稿还在。
 *
 * 标签只写名字，不再摆图标 + 一句说明的大卡片：那一层盒子会和下面的
 * 话题卡片、回答内容叠成三层，而「谁在提问」看一眼标签就知道。
 */
type View = 'qa' | 'learn';

const MODES: { id: View; label: string; busyKind: 'answer' | 'learn' }[] = [
  { id: 'qa', label: '问 AI', busyKind: 'answer' },
  { id: 'learn', label: 'AI 问', busyKind: 'learn' },
];

const tabDomId = (view: View) => `mode-tab-${view}`;
const panelDomId = (view: View) => `mode-panel-${view}`;

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [state, setState] = useState<PanelState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const conversationKey = state?.sessionId ?? `${state?.tabId}:${state?.pageUrl}`;
  const [selection, setSelection] = useState<{ session: string; view: View } | null>(null);
  // Resolve a new article synchronously; a mounted hidden mode must not start a paid request.
  const view = selection?.session === conversationKey ? selection.view
    : state?.learning?.status === 'active' ? 'learn' : 'qa';
  const setView = (next: View) => setSelection({ session: conversationKey, view: next });
  const clientRef = useRef<Client | null>(null);

  useEffect(() => {
    const client = createClient({
      onState: (next) => {
        setState(next);
        const session = next.sessionId ?? `${next.tabId}:${next.pageUrl}`;
        setSelection((current) => current?.session === session ? current
          : { session, view: next.learning?.status === 'active' ? 'learn' : 'qa' });
      },
      onQuote: (event) => setState((current) =>
        current?.tabId === event.tabId && current.sessionId === event.sessionId
          ? { ...current, quote: event.quote } : current),
      onProgress: (chars, draft, reasoning) => {
        setState((current) =>
          current?.busy && !current.busy.agent && !['running', 'waiting'].includes(current.researchPending?.status ?? '')
            ? { ...current, busy: { ...current.busy, chars, draft, reasoning } } : current,
        );
      },
      onAgent: (event) => setState((current) => {
        if (current?.tabId !== event.identity.tabId || current.sessionId !== event.identity.sessionId ||
            current.pageUrl !== event.identity.url || current.settings.provider !== event.identity.modelProvider ||
            current.busy?.kind !== 'answer' || current.researchPending?.runId !== event.identity.runId ||
            !['running', 'waiting'].includes(current.researchPending.status) ||
            (current.busy.agent && event.seq <= current.busy.agent.seq)) return current;
        return { ...current, researchDetails: event.details ?? current.researchDetails,
          busy: { ...current.busy, agent: event, draft: '', reasoning: '' } };
      }),
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

  const quoteIdentity = state?.quote?.id ?? state?.quote?.text;
  useEffect(() => {
    if (!quoteIdentity) return;
    setView('qa');
    window.setTimeout(() => document.getElementById('question')?.focus(), 0);
  }, [quoteIdentity]);

  const send = useCallback(async (command: Command): Promise<Reply | undefined> => {
    setNotice(null);
    const reply = await clientRef.current?.send(command);
    if (reply && !reply.ok) setNotice(reply.error.message);
    else if (reply?.message) setNotice(reply.message);
    return reply;
  }, []);

  /**
   * 点入口才读这一页。页面已经换过、或还没有地址时，这一下先向浏览器要读取网页的许可
   * （必须是这次点击里的第一个等待，否则授权窗不会出现）。已经允许过就不会再问。
   * 外发确认仍合在同一次点击里：拆成两个按钮时，后面那个曾经是禁用的，点了没反应。
   */
  const readPage = (entry: PageEntryId | 'retry') => {
    if (!state || state.tabId === null) return;
    const tabId = state.tabId;
    const confirm = !state.outboundConfirmed;
    const askHost = needsPageHost(state.permission, state.error?.code ?? null);
    void (async () => {
      if (askHost) {
        let granted = false;
        try {
          granted = await browser.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
        } catch {
          granted = false;
        }
        if (!granted) {
          setNotice('没有获得网页读取权限。可以在当前页再点一次工具栏上的WebKnow AI图标，随后点侧栏阅读入口，只授权这一页。');
          return;
        }
      }
      if (confirm) {
        const reply = await send({ type: 'confirmOutbound' });
        if (!reply?.ok) return;
      }
      setView(entry === 'learn' ? 'learn' : 'qa');
      await send({ type: 'start', tabId });
    })();
  };

  /**
   * 设置打开成独立标签页，不在侧栏里展开：阅读才在侧栏，改配置不是阅读，
   * 不该被侧栏宽度限制。地址带上当前页号，设置页里的“清掉这一页的内容”才指得准。
   */
  // ponytail: 连点两次会开两个设置标签页。要复用已有那个得用 runtime.getContexts 找出来再聚焦，
  // 现在不值得。真的烦了再加。
  const openSettings = (category?: string) => {
    const url = new URL(browser.runtime.getURL('/options.html'));
    if (state?.tabId != null) url.searchParams.set('tab', String(state.tabId));
    if (category) url.hash = category;
    void openSettingsTab(url.toString()).catch(() => setNotice('设置页没有打开，请再试一次。'));
  };

  /** WAI-ARIA tabs 的键盘约定：左右移动选择并把焦点带过去，Home/End 到头尾。 */
  const onModeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = MODES.findIndex((mode) => mode.id === view);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % MODES.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + MODES.length) % MODES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = MODES.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const target = MODES[next]!;
    setView(target.id);
    document.getElementById(tabDomId(target.id))?.focus();
  };

  const phase = state?.phase ?? 'READY_TO_START';
  const busy = state?.busy ?? null;
  const readyShell = phase === 'READY' || phase === 'LEARNING';
  // 「还没有填钥匙」那句要带上当前供应商的名字，所以它在映射之外单独拼。
  const phaseText = readyShell
    ? null
    : phase === 'UNCONFIGURED'
      ? '还没有填钥匙。去设置里配一下，顺带看看都能做什么。'
      : PHASE_TEXT[phase];
  const pageEntryPhase = Boolean(state) &&
    (phase === 'PERMISSION_REQUIRED' || phase === 'READY_TO_START' || phase === 'STALE');
  const awaitingNewReceiver = !state?.outboundConfirmed &&
    (state?.sessionState === 'READY' || state?.sessionState === 'LEARNING');

  const holdConversation = readyShell || Boolean(state?.guide &&
    (state.sessionState === 'READY' || state.sessionState === 'LEARNING'));
  const modeTabs = readyShell && (
<div className="modes" role="tablist" aria-label="功能切换" onKeyDown={onModeKeyDown}>
                {MODES.map((mode) => (
                  <button
                    key={mode.id}
                    id={tabDomId(mode.id)}
                    type="button"
                    role="tab"
                    className="mode"
                    data-mode={mode.id}
                    aria-selected={view === mode.id}
                    aria-controls={panelDomId(mode.id)}
                    tabIndex={view === mode.id ? 0 : -1}
                    onClick={() => setView(mode.id)}
                  >
                    {mode.label}
                    {busy?.kind === mode.busyKind && (
                      <>
                        <span className="dot" aria-hidden="true" />
                        <span className="sr-only">正在处理</span>
                      </>
                    )}
                  </button>
                ))}
              </div>
  );

  return (
    <div
      className={readyShell ? "panel ready-chat" : "panel"}
      style={state?.settings.fontSize === 'large' ? { zoom: 1.15 } : undefined}
    >
      <div className="conversation-top">
      <header className="context-actions panel-header">
        <span role="img" aria-label="WebKnow AI"><BrandMark /></span>
        {!pageEntryPhase && state?.pageTitle && <p className="page-title">{state.pageTitle}</p>}
        <button type="button" className="icon-btn" onClick={() => openSettings()} aria-label="设置" title="设置"><Icon name="settings" /></button>
      </header>
      {state?.completeness && <div className="context" role="region" aria-label="文章信息" tabIndex={0}>
        <ScopeLine completeness={state.completeness} onJump={(blockId) => state.tabId !== null && void send({ type: 'jump', tabId: state.tabId, blockId })} />
      </div>}

      {modeTabs}
      </div>

      {(notice || state?.error) && <div className="conversation-notices" role="region" aria-label="状态提示" tabIndex={0}>
        {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}
        {state?.error && <ErrorBanner error={state.error} />}
      </div>}

      {!state ? (
        <p className="hint">正在连接后台…</p>
      ) : (
        <>
          {phaseText && (
            <p className="phase" role="status" aria-live="polite">
              {phaseText}
            </p>
          )}

          {phase === 'UNCONFIGURED' && <Setup settings={state.settings} onOpenSettings={() => openSettings('model')} />}

          {(phase === 'PERMISSION_REQUIRED' || phase === 'READY_TO_START' || phase === 'STALE') && (
            <>
              {!state.outboundConfirmed ? (
                <OutboundNotice
                  state={state}
                />
              ) : (
                <p className="hint">
                  {outboundConfirmedHint(
                    findProvider(state.settings.provider).receiver,
                    state.settings.provider === 'deepseek',
                    state.settings,
                  )}
                </p>
              )}
              {awaitingNewReceiver ? (
                <Section title="外发接收方或范围已变化">
                  <p>之前的摘要与对话仍在，由此前的模型生成。阅读新的外发说明并确认后可以继续；新的提问使用当前接收方和范围。</p>
                  <button type="button" disabled={busy !== null} onClick={() => readPage('retry')}>
                    我确认，继续伴读
                  </button>
                </Section>
              ) : (
                <PageEntry
                  pageTitle={state.pageTitle}
                  phase={phase}
                  outboundConfirmed={state.outboundConfirmed}
                  busy={busy !== null}
                  askHost={needsPageHost(state.permission, state.error?.code ?? null)}
                  onPick={readPage}
                />
              )}
            </>
          )}

          {phase === 'ANALYZING' &&
            (busy?.draft || busy?.reasoning ? (
              <Drafting
                text={busy?.draft ?? ''}
                reasoning={busy?.reasoning ?? ''}
                onStop={() => state.tabId !== null && void send({ type: 'stop', tabId: state.tabId })}
              />
            ) : (
              <Busy
                label="正在提取正文并生成首屏"
                chars={busy?.chars ?? 0}
                onStop={() => state.tabId !== null && void send({ type: 'stop', tabId: state.tabId })}
              />
            ))}

          {phase === 'ERROR' && (
            <Section title="重新试一次">
              <p className="hint">
                刚才那一步没成功，失败了的结果不会拿来充数。可以重新开始，页面内容还留着。
              </p>
              <div className="composer-actions">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => readPage('retry')}
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

          {holdConversation && (
            <>
              {/* 两个面板都挂载、只藏未选中的那个：切回来时输入草稿还在（ARIA tabs 的标准形态）。 */}
              <div
                key={`${conversationKey}:qa`}
                id={panelDomId('qa')}
                role="tabpanel"
                aria-labelledby={tabDomId('qa')}
                hidden={!readyShell || view !== 'qa'}
              >
                <Reading state={state} send={send} active={readyShell && view === 'qa'} onSearchSettings={() => openSettings('search')} />
              </div>
              <div
                key={`${conversationKey}:learn`}
                id={panelDomId('learn')}
                role="tabpanel"
                aria-labelledby={tabDomId('learn')}
                hidden={!readyShell || view !== 'learn'}
              >
                <Learning state={state} send={send} active={readyShell && view === 'learn'} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** 首次外发前的告知与确认；接收方或范围变化后需要重新确认（FR-022）。 */
function OutboundNotice({
  state,
}: {
  state: PanelState;
}) {
  const provider = findProvider(state.settings.provider);
  return (
    <div className="banner banner-info">
      <p>开始之前，请先确认这几件事：</p>
      <ul>
        {outboundReceiverLines(state.settings).map(line => <li key={line}>{line}</li>)}
        <li>模型、搜索服务、自建实例地址、来源读取方式或告知版本变化后，需要再次确认外发范围。</li>
        <li>{outboundFeeLine(provider.name)}</li>
        <li>请只在这一页是公开的、你有权这样使用的时候才用。</li>
      </ul>
      <p className="hint">{outboundRetentionLine(provider.name)}</p>
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
  PERMISSION_REQUIRED: '点一个，我才读你正在看的这一页。',
  // 能读的时候，这句话写在入口段落里。状态行再写一遍，页面上会有两句一样的话。
  ANALYZING: '正在读这一页，马上给你摘要。',
  STALE: '换了一页。上一页的内容已经放下。',
  UNSUPPORTED: '这一页暂时读不了。',
  ERROR: '上一步没成功。',
};
