import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { browser } from 'wxt/browser';

import { findProvider } from '../core/model-providers';
import type { Command, PanelState, Reply } from '../core/protocol';
import { activeTabId, createClient, type Client } from './api';
import { Learning } from './components/Learning';
import { Reading } from './components/Reading';
import { Setup } from './components/Setup';
import { Busy, ErrorBanner, Notice, ScopeLine, Section } from './components/bits';
import { BrandMark, Icon, type IconName } from './components/Icon';
import { outboundConfirmedHint, outboundFeeLine, outboundRetentionLine } from './outbound-copy';

const START_LABEL: Record<string, string> = {
  READY_TO_START: '开始伴读',
  STALE: '重新开始',
};

/**
 * 已就绪后的两个能力用分段切换：「我问」是摘要 + 话题 + 自己提问，
 * 「问我」是它反过来考你。进行中也能随时切回（会话留在后台，不因切换而中断）；
 * 两个面板都保持挂载，所以切回来时草稿还在。
 */
type View = 'qa' | 'learn';

const MODES: { id: View; label: string; hint: string; icon: IconName; busyKind: 'answer' | 'learn' }[] = [
  { id: 'qa', label: '我问', hint: '你来提问', icon: 'book', busyKind: 'answer' },
  { id: 'learn', label: '问我', hint: '它来提问', icon: 'chat', busyKind: 'learn' },
];

const tabDomId = (view: View) => `mode-tab-${view}`;
const panelDomId = (view: View) => `mode-panel-${view}`;

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [state, setState] = useState<PanelState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>('qa');
  const learningWasActive = useRef(false);
  const booted = useRef(false);
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

  // 学习会话从无到有时自动切到「问我」；其余时候尊重用户所在的位置。
  const learningActive = state?.learning?.status === 'active';
  useEffect(() => {
    if (learningActive && !learningWasActive.current) {
      setView('learn');
      if (booted.current) document.getElementById(tabDomId('learn'))?.focus();
    }
    learningWasActive.current = learningActive;
    booted.current = true;
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

  /**
   * 设置打开成独立标签页，不在侧栏里展开：阅读才在侧栏，改配置不是阅读，
   * 不该被侧栏宽度限制。地址带上当前页号，设置页里的“清掉这一页的内容”才指得准。
   */
  // ponytail: 连点两次会开两个设置标签页。要复用已有那个得用 runtime.getContexts 找出来再聚焦，
  // 现在不值得。真的烦了再加。
  const openSettings = () => {
    const url = browser.runtime.getURL('/options.html');
    void browser.tabs.create({ url: state?.tabId != null ? `${url}#${state.tabId}` : url });
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
      ? `还没有填 ${findProvider(state?.settings.provider).name} 钥匙。`
      : PHASE_TEXT[phase];

  return (
    <div
      className="panel"
      style={state?.settings.fontSize === 'large' ? { zoom: 1.15 } : undefined}
    >
      <header className="panel-header">
        <div className="brand">
          <BrandMark />
          <div className="brand-copy">
            <h1>知伴</h1>
            <p className="brand-sub">陪你读这一页</p>
          </div>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={openSettings}
          aria-label="设置"
          title="设置"
        >
          <Icon name="settings" />
        </button>
      </header>

      {notice && <Notice text={notice} onDismiss={() => setNotice(null)} />}
      {state?.error && <ErrorBanner error={state.error} />}

      {!state ? (
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
                <OutboundNotice
                  state={state}
                  searchProviderName={state.settings.search.enabled ? state.settings.search.providerName : null}
                />
              ) : (
                <p className="hint">
                  {outboundConfirmedHint(findProvider(state.settings.provider).receiver)}
                </p>
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
              <div className="modes" role="tablist" aria-label="功能切换" onKeyDown={onModeKeyDown}>
                {MODES.map((mode) => (
                  <button
                    key={mode.id}
                    id={tabDomId(mode.id)}
                    type="button"
                    role="tab"
                    className="mode"
                    data-mode={mode.id}
                    aria-label={mode.label}
                    aria-selected={view === mode.id}
                    aria-controls={panelDomId(mode.id)}
                    tabIndex={view === mode.id ? 0 : -1}
                    onClick={() => setView(mode.id)}
                  >
                    <Icon name={mode.icon} small />
                    <span className="mode-copy">
                      <span className="mode-label">{mode.label}</span>
                      <span className="mode-hint">{mode.hint}</span>
                    </span>
                    {busy?.kind === mode.busyKind && (
                      <>
                        <span className="dot" aria-hidden="true" />
                        <span className="sr-only">正在处理</span>
                      </>
                    )}
                  </button>
                ))}
              </div>

              {/* 两个面板都挂载、只藏未选中的那个：切回来时输入草稿还在（ARIA tabs 的标准形态）。 */}
              <div
                id={panelDomId('qa')}
                role="tabpanel"
                aria-labelledby={tabDomId('qa')}
                hidden={view !== 'qa'}
              >
                <Reading state={state} send={send} />
              </div>
              <div
                id={panelDomId('learn')}
                role="tabpanel"
                aria-labelledby={tabDomId('learn')}
                hidden={view !== 'learn'}
              >
                <Learning state={state} send={send} />
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
  searchProviderName,
}: {
  state: PanelState;
  searchProviderName: string | null;
}) {
  const provider = findProvider(state.settings.provider);
  return (
    <div className="banner banner-info">
      <p>开始之前，请先确认这几件事：</p>
      <ul>
        <li>
          你正在看的这一页的文字，会发给 <strong>{provider.receiver}</strong> 这家公司（不是发给我们）。
          你换了模型供应商，接收方就会跟着换——换完之后这里会再问你一次。
        </li>
        <li>发过去的是：这一页的正文、你提的问题，以及前面几轮对话。</li>
        {searchProviderName && (
          <li>
            你还启用了联网搜索（{searchProviderName}）：打开那个开关提问时，你的<strong>搜索词</strong>会发给它；
            文章正文不会发给它。
          </li>
        )}
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
  PERMISSION_REQUIRED: '等你在浏览器里允许读取这个网站。',
  READY_TO_START: '准备好了。你点开始，我才读这一页。',
  ANALYZING: '正在读这一页，马上给你摘要。',
  STALE: '页面换了，之前的内容已经作废。',
  UNSUPPORTED: '这一页暂时读不了。',
  ERROR: '上一步没成功。',
};
