import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';

import { activeTabId } from '../api';
import { openDiagram } from '../diagram-window';
import { Icon } from './Icon';

/**
 * 图表渲染。这个模块被 Rich.tsx 懒加载，因此 mermaid 不进主包。
 *
 * 图表源码来自模型输出，属不可信数据：
 * - `securityLevel: 'strict'` 与 `htmlLabels: false` 禁止标签里的 HTML 与脚本；
 * - SVG 仅交给预览和独立查看器的受控容器；
 * - 渲染失败如实显示，不假装成功（与 FR-018 同一条纪律）。
 */

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; svg: string }
  | { phase: 'failed' };

let ready: Promise<typeof import('mermaid').default> | null = null;

/** mermaid 只初始化一次；主题跟随当前深浅色。 */
function loadMermaid() {
  if (!ready) {
    ready = import('mermaid').then(({ default: mermaid }) => {
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        theme: 'base',
        fontFamily: 'inherit',
        themeVariables: dark
          ? {
              background: '#131313',
              primaryColor: '#49302b',
              primaryTextColor: '#fff1eb',
              primaryBorderColor: '#e9947b',
              secondaryColor: '#23413e',
              secondaryTextColor: '#e1f6f2',
              secondaryBorderColor: '#71bcb1',
              tertiaryColor: '#493c24',
              tertiaryTextColor: '#fff3d2',
              tertiaryBorderColor: '#dbb867',
              lineColor: '#b6b3ad',
              textColor: '#ededed',
            }
          : {
              background: '#ffffff',
              primaryColor: '#fbe8df',
              primaryTextColor: '#492b21',
              primaryBorderColor: '#bd674b',
              secondaryColor: '#e1f2ee',
              secondaryTextColor: '#254940',
              secondaryBorderColor: '#5aa798',
              tertiaryColor: '#fff1cc',
              tertiaryTextColor: '#4d3c16',
              tertiaryBorderColor: '#c79c44',
              lineColor: '#6c6b68',
              textColor: '#171717',
            },
      });
      return mermaid;
    });
  }
  return ready;
}

let sequence = 0;

export function Diagram({ source }: { source: string }) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    sequence += 1;
    const id = `wka-diagram-${sequence}`;

    loadMermaid()
      .then((mermaid) => mermaid.render(id, source))
      .then(({ svg }) => {
        if (!cancelled) setState({ phase: 'ok', svg });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'failed' });
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  // SVG 是 mermaid 在 strict 模式下生成的结构化图形，没有脚本与外链；
  // 用容器 innerHTML 注入是 mermaid 的既定用法，容器本身不接受模型的原始文本。
  useEffect(() => {
    if (state.phase === 'ok' && host.current) host.current.innerHTML = state.svg;
  }, [state]);

  if (state.phase === 'loading') return <div className="diagram-loading">正在画图…</div>;

  if (state.phase === 'failed') {
    return (
      <figure className="diagram-failed">
        <pre className="rich-code">
          <code>{source}</code>
        </pre>
        <figcaption>这张图没画出来。上面是它的原始内容。</figcaption>
      </figure>
    );
  }

  const show = async () => {
    if (opening) return;
    setOpening(true);
    setOpenError(false);
    try {
      const id = await activeTabId();
      if (id === null) throw new Error('没有来源文章');
      const sourceTab = await browser.tabs.get(id);
      await openDiagram({ svg: state.svg, title: sourceTab.title ? `${sourceTab.title} · 图表` : '文章图表', sourceTabId: id, sourceWindowId: sourceTab.windowId });
    } catch { setOpenError(true); }
    finally { setOpening(false); }
  };

  return (
    <>
      <figure className="diagram">
        <button type="button" className="diagram-canvas" disabled={opening} onClick={() => void show()} aria-label="放大看这张图" title="在独立窗口看图">
          <div ref={host} aria-hidden="true" />
        </button>
        <figcaption>
          <button type="button" className="quiet diagram-open" disabled={opening} onClick={() => void show()}>
            <Icon name="external" small />{opening ? '正在打开…' : '打开大图'}
          </button>
        </figcaption>
        {openError && <p className="hint" role="status">没能打开图表，请再点一次。</p>}
      </figure>
    </>
  );
}
