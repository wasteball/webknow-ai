/** 换页或尚未开始时的入口。点下去才读这一页，不在导航时自动读。 */

export type PageEntryId = 'summary' | 'questions' | 'learn';

/**
 * 工具栏那一次点击的读取权会在导航后失效。
 * 页面已经换了，或根本还不知道地址，或上次就是因为没读到而失败：
 * 这一下要点按钮时向浏览器要「读取打开的网页」。已经允许过就不再弹窗。
 * 刚点过工具栏、地址还在的那一次不用再要。
 */
export function needsPageHost(
  phase: string,
  permission: 'granted' | 'missing' | 'unknown',
  errorCode: string | null,
): boolean {
  if (phase === 'STALE' || permission !== 'granted') return true;
  return errorCode === 'PERMISSION_MISSING';
}

export function pageEntryLabel(id: PageEntryId, outboundConfirmed: boolean): string {
  if (id === 'summary') return outboundConfirmed ? '总结摘要' : '我确认，总结摘要';
  if (id === 'questions') return '出几个问题';
  return '让它问我';
}
