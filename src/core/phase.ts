import type { Phase } from './protocol';
import type { SessionState } from './session';

/**
 * 页面状态推导（PRD 4.2）。优先级：配置 → 权限 → 会话状态。
 * 纯函数，界面只负责渲染，避免“状态判断”散落在组件里。
 */
export function derivePhase(input: {
  hasKey: boolean;
  permission: 'granted' | 'missing' | 'unknown';
  sessionState: SessionState | null;
  unsupportedReason: string | null;
}): Phase {
  if (!input.hasKey) return 'UNCONFIGURED';
  if (input.unsupportedReason) return 'UNSUPPORTED';

  const session = input.sessionState;
  if (!session) {
    return input.permission === 'granted' ? 'READY_TO_START' : 'PERMISSION_REQUIRED';
  }
  switch (session) {
    case 'STALE':
      return 'STALE';
    case 'ANALYZING':
      return 'ANALYZING';
    case 'READY':
      return 'READY';
    case 'LEARNING':
      return 'LEARNING';
    case 'ERROR':
      return 'ERROR';
    case 'READY_TO_START':
      return input.permission === 'granted' ? 'READY_TO_START' : 'PERMISSION_REQUIRED';
  }
}
