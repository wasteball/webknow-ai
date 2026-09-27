import { useEffect, useRef, useState } from 'react';

import { Viewer } from './Viewer';

/**
 * 图表渲染。这个模块被 Rich.tsx 懒加载，因此 mermaid 不进主包。
 *
 * 图表源码来自模型输出，属不可信数据：
 * - `securityLevel: 'strict'` 与 `htmlLabels: false` 禁止标签里的 HTML 与脚本；
 * - mermaid 返回的 SVG 字符串只交给 Viewer 内部的受控容器，不进入正文流的 innerHTML 路径之外的地方；
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
              primaryColor: '#1e1e1e',
              primaryTextColor: '#ededed',
              primaryBorderColor: '#3a3a3a',
              lineColor: '#6b6b6b',
              secondaryColor: '#1a1a1a',
              tertiaryColor: '#161616',
            }
          : {
              background: '#ffffff',
              primaryColor: '#f6f6f6',
              primaryTextColor: '#171717',
              primaryBorderColor: '#d8d8d8',
              lineColor: '#9a9a9a',
              secondaryColor: '#fafafa',
              tertiaryColor: '#fcfcfc',
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
  const [open, setOpen] = useState(false);
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

  return (
    <>
      <figure className="diagram">
        <button type="button" className="diagram-canvas" onClick={() => setOpen(true)} title="放大看这张图">
          <div ref={host} aria-hidden="true" />
        </button>
        <figcaption>
          <span>图</span>
          <button type="button" className="quiet" onClick={() => setOpen(true)}>
            放大
          </button>
        </figcaption>
      </figure>
      {open && <Viewer svg={state.svg} onClose={() => setOpen(false)} />}
    </>
  );
}
