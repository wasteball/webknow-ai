import type { ReactNode } from 'react';

/**
 * 图标取自原型 companion-ai-prototype.html 的 SVG sprite（原样搬运路径数据）。
 * 统一 24×24 视框、描边不填充，描边参数在 style.css 的 .icon 里，
 * 所以这里只负责给图形，颜色一律跟着 currentColor 走。
 *
 * 只收录界面真正用到的那些：每多一个就多一份要维护的路径数据。
 * 需要新图标时从原型 sprite 里再抄一条（id 形如 `i-xxx`）。
 */
/** 品牌印：朱红方印里一枚书签。颜色跟 currentColor，外框由调用方设成印色。 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="brand-seal"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path
        fill="#fff"
        d="M11.2 5.2h9.6v16.4L16 18.2l-4.8 3.4V5.2Z"
      />
    </svg>
  );
}

export type IconName =
  | 'book'
  | 'chat'
  | 'settings'
  | 'spark'
  | 'file'
  | 'image'
  | 'external'
  | 'send'
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
  | 'grid';

const PATHS: Record<IconName, ReactNode> = {
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
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
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
};

/**
 * 图标是装饰性的：旁边的文字已经说清了意思，所以对读屏器隐藏。
 * 单独用图标当按钮时，按钮自己必须带 aria-label。
 */
export function Icon({ name, small = false }: { name: IconName; small?: boolean }) {
  return (
    <svg
      className={small ? 'icon icon-sm' : 'icon'}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
