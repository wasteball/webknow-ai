import { useState, type ReactNode } from 'react';
import { DIAGRAM_ICON_PATHS, type DiagramIconName } from '../../core/diagram-icons';

/**
 * 基础图标取自原型 companion-ai-prototype.html 的 SVG sprite；图表工具栏图标与整页查看器共用 diagram-icons.ts。
 * 统一 24×24 视框、描边不填充，描边参数在 style.css 的 .icon 里，
 * 所以这里只负责给图形，颜色一律跟着 currentColor 走。
 *
 * 只收录界面真正用到的那些：每多一个就多一份要维护的路径数据。
 * 需要新图标时从原型 sprite 里再抄一条（id 形如 `i-xxx`）。
 */
/**
 * 品牌光点：同一个光点既是 logo，也是助手状态。平时静止；thinking 时外晕与内核一起呼吸
 * （style.css 的 .orb，尊重“减少动态效果”）。渐变 ID 每处唯一，免得同页多个光点互相引用。
 */
let orbSeq = 0;
export function BrandMark({ size = 28, thinking = false }: { size?: number; thinking?: boolean }) {
  const [id] = useState(() => `orb-g${++orbSeq}`);
  return (
    <svg className="orb" data-state={thinking ? 'thinking' : 'idle'} width={size} height={size}
      viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={id} cx="34%" cy="30%" r="75%">
          <stop offset="0" stopColor="#a5b4fc" />
          <stop offset=".55" stopColor="#6366f1" />
          <stop offset="1" stopColor="#5b21b6" />
        </radialGradient>
      </defs>
      <circle className="orb-halo" cx="16" cy="16" r="15" fill="#818cf8" opacity=".18" />
      <circle cx="16" cy="16" r="12" fill={`url(#${id})`} />
      <circle className="orb-core" cx="16" cy="16" r="4.6" fill="#fff" />
      <circle cx="23.2" cy="8.8" r="2.3" fill="#fbbf24" />
    </svg>
  );
}

type BaseIconName =
  | 'book'
  | 'chat'
  | 'settings'
  | 'spark'
  | 'file'
  | 'image'
  | 'external'
  | 'send'
  | 'stop'
  | 'check'
  | 'info'
  | 'globe'
  | 'cloud'
  | 'cpu'
  | 'lightbulb'
  | 'rotate'
  | 'flag'
  | 'x'
  | 'lock'
  | 'puzzle'
  | 'grid'
  | 'more'
  | 'collapse'
  | 'trash'
  | 'help'
  | 'back'
  | 'chev'
  | 'key'
  | 'quote'
  | 'arrowTurn'
  | 'sliders'
  | 'sun'
  | 'shelf'
  | 'play';

export type IconName = BaseIconName | DiagramIconName;

const PATHS: Record<BaseIconName, ReactNode> = {
  book: (
    <>
      <path d="M4 5a3 3 0 0 1 3-3h13v17H7a3 3 0 0 0-3 3Z" />
      <path d="M4 5v17M8 6h8" />
    </>
  ),
  chat: (
    <>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
      <path d="M8 9h8M8 13h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8Z" />
      <path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 15-5-5L5 20" />
    </>
  ),
  external: (
    <path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
  ),
  send: (
    <>
      <path d="m6 10 6-6 6 6M12 4v16" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  check: <path d="m5 12 4 4L19 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  cloud: (
    <>
      <path d="M17.5 19H6a4 4 0 0 1-.4-8A6.5 6.5 0 0 1 18 9a5 5 0 0 1-.5 10Z" />
      <path d="m9 14 3-3 3 3M12 11v7" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </>
  ),
  lightbulb: (
    <path d="M9 18h6M10 22h4M8.2 14.5A7 7 0 1 1 15.8 14.5 4.2 4.2 0 0 0 14 18h-4a4.2 4.2 0 0 0-1.8-3.5Z" />
  ),
  rotate: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M18.7 9A7 7 0 0 0 6.2 6.2L4 8M5.3 15A7 7 0 0 0 17.8 17.8L20 16" />
    </>
  ),
  flag: <path d="M5 22V4M5 5h11l-1 4 1 4H5" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  puzzle: <path d="M19 13h-2a2 2 0 1 0 0 4h2v3H5v-4h2a2 2 0 1 0 0-4H5V8h4V6a2 2 0 1 1 4 0v2h6Z" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  collapse: <path d="M13 6l6 6-6 6M5 6l6 6-6 6" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />,
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  chev: <path d="M9 6l6 6-6 6" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M10.8 12.2L20 3M16 7l3 3" />
    </>
  ),
  quote: <path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6" />,
  arrowTurn: <path d="M5 5v6a3 3 0 0 0 3 3h11M15 10l4 4-4 4" />,
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5" />
    </>
  ),
  shelf: <path d="M4 4h4v16H4zM10 4h4v16h-4zM15.5 5.2l3.8-1 3.7 14.5-3.8 1z" />,
  play: <path d="M8 5v14l11-7Z" />,
};

/**
 * 图标是装饰性的：旁边的文字已经说清了意思，所以对读屏器隐藏。
 * 单独用图标当按钮时，按钮自己必须带 aria-label。
 */
export function Icon({ name, small = false }: { name: IconName; small?: boolean }) {
  const paths = name in DIAGRAM_ICON_PATHS
    ? DIAGRAM_ICON_PATHS[name as DiagramIconName].map((path) => <path key={path} d={path} />)
    : PATHS[name as BaseIconName];
  return (
    <svg
      className={name === 'stop' ? (small ? 'icon icon-sm icon-fill' : 'icon icon-fill') : small ? 'icon icon-sm' : 'icon'}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {paths}
    </svg>
  );
}
