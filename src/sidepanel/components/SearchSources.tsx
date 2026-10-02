import type { ChatReference, ResearchSummary } from '../../core/search/agent-types';

const readLabels: Record<ChatReference['readStatus'], string> = {
  read: '已读正文', not_read: '未读正文，仅搜索摘要', unavailable: '正文不可读取，仅搜索摘要',
};
const dateLabels = { fresh: '符合本题时间范围', stale: '不符合本题时间范围', date_unknown: '发布时间未知', not_applicable: '无时间要求' };
const freshnessLabels = { verified: '已核验时间', date_unknown: '发布时间未知，未完成时间核验', stale: '资料较旧', not_applicable: '无时间要求' };

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Metadata comes from the backend's content-free allowlist, never a model URL or checkpoint. */
export function SearchSources({ references, research }: { references: ChatReference[]; research?: ResearchSummary }) {
  if (!research && references.length === 0) return null;
  const accepted = research ? research.sources.filter(source => source.decision === 'accepted') : references;
  const unused = research?.sources.filter(source => source.decision !== 'accepted') ?? [];
  const renderSource = (source: ChatReference) => {
    const url = safeSourceUrl(source.url);
    return <>
      {url ? <a href={url} target="_blank" rel="noreferrer">{source.title || source.domain || url}</a> : <span>{source.title || source.domain || '来源地址不可用'}</span>}
      <p>发布时间：{source.publishedAt ?? '日期未知'} · 检索时间：{source.retrievedAt || '未知'}</p>
      <p>{source.domain} · {readLabels[source.readStatus]}</p>
    </>;
  };
  return <details className="research-details">
    <summary>本轮搜索详情</summary>
    {research && <>
      <p>搜索 {research.attempts.length} 次 · 来源 {research.sources.length} 个 · {freshnessLabels[research.freshness]}</p>
      {research.degraded && <p>本轮仍有未能确认的部分。</p>}
      <h4>查询记录</h4>
      <ol>{research.attempts.map(attempt => <li key={attempt.id}>
        <p>{attempt.action.query}</p>
        <p>第 {attempt.id} 次 · 找到 {attempt.sourceIds.length} 个来源 · 检索时间：{attempt.retrievedAt}</p>
        {attempt.status !== 'ok' && <p>{({ empty: '未找到资料', transient: '暂时不可用', failed: '搜索失败' })[attempt.status]}</p>}
      </li>)}</ol>
    </>}
    <h4>已采用来源</h4>
    {accepted.length ? <ul>{accepted.map(source => <li key={source.sourceId}>{renderSource(source)}</li>)}</ul> : <p>暂无已采用来源。</p>}
    {research && <>
      <h4>未采用来源</h4>
      {unused.length ? <ul>{unused.map(source => <li key={source.sourceId}>
        {renderSource(source)}
        <p>{source.decision === 'rejected' ? '已舍弃' : '待核验'} · {dateLabels[source.dateStatus]}{source.reason ? ` · 原因：${source.reason}` : ''}</p>
        {source.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      </li>)}</ul> : <p>没有未采用来源。</p>}
      {research.conflicts.length > 0 && <><h4>来源冲突</h4><ul>{research.conflicts.map((conflict, index) => <li key={index}>{conflict.description}</li>)}</ul></>}
    </>}
  </details>;
}
