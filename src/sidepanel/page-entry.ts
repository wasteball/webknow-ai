/** 换页或尚未开始时的入口。点下去才读这一页，不在导航时自动读。 */

export type PageEntryId = 'summary' | 'questions' | 'learn';

/**
 * 工具栏那一次点击的读取权会在导航后失效。
 * 页面已经换了但没有可用授权，或上次注入失败：
 * 这一下要点按钮时向浏览器要「读取打开的网页」。
 * 刚点过工具栏并取得当前页 activeTab 的那一次不用再要。
 */
export function needsPageHost(
  permission: 'granted' | 'missing' | 'unknown',
  errorCode: string | null,
): boolean {
  if (permission !== 'granted') return true;
  return errorCode === 'PERMISSION_MISSING';
}

export function pageEntryLabel(id: PageEntryId, outboundConfirmed: boolean): string {
  const label = id === 'summary' ? '总结摘要' : id === 'questions' ? '出几个问题' : '让它问我';
  return outboundConfirmed ? label : `我确认，${label}`;
}
