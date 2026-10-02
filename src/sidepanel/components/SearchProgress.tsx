import type { AgentEvent, AgentPhase } from '../../core/search/agent-types';

const labels: Record<AgentPhase, string> = {
  deciding: '正在判断是否需要联网',
  searching: '正在搜索资料',
  reading: '正在读取来源',
  checking: '正在核对证据和时间',
  answering: '正在组织回答',
  waiting: '需要你补充一个条件',
  degraded: '正在说明可以确认的部分',
};
const reasons: Partial<Record<AgentEvent['reason'], string>> = {
  retry: '正在换一种查询继续核验',
  conflict: '来源存在冲突，正在核对',
  insufficient: '证据仍有缺口',
  timeout: '等待时间已到，说明尚未核验的部分',
};

/** Only backend-generated phases, counts and reasons belong in live progress. */
export function SearchProgress({ event }: { event: AgentEvent }) {
  return <div className="research-progress" role="status" aria-live="polite">
    <p>{labels[event.phase]}{event.phase === 'searching' && event.searches > 0 ? ` · 第 ${event.searches} 次搜索` : ''}</p>
    <p className="hint">已搜索 {event.searches} 次 · 已读取 {event.reads} 个来源{reasons[event.reason] ? ` · ${reasons[event.reason]}` : ''}</p>
  </div>;
}
