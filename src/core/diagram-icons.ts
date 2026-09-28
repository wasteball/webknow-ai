/** 图表工具栏在侧栏 React 视图和整页查看器里共用的静态 SVG 路径。 */
export const DIAGRAM_ICON_PATHS = {
  zoomOut: ['M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', 'M17 17l4 4', 'M8 11h6'],
  zoomIn: ['M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', 'M17 17l4 4', 'M8 11h6', 'M11 8v6'],
  fit: ['M9 4v3a2 2 0 0 1-2 2H4', 'M20 9h-3a2 2 0 0 1-2-2V4', 'M4 15h3a2 2 0 0 1 2 2v3', 'M15 20v-3a2 2 0 0 1 2-2h3'],
  fullscreen: ['M9 4H5a1 1 0 0 0-1 1v4', 'M15 4h4a1 1 0 0 1 1 1v4', 'M4 15v4a1 1 0 0 0 1 1h4', 'M20 15v4a1 1 0 0 1-1 1h-4'],
  fullscreenExit: ['M9 4v5H4', 'M15 4v5h5', 'M4 15h5v5', 'M20 15h-5v5'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
} as const;

export type DiagramIconName = keyof typeof DIAGRAM_ICON_PATHS;
