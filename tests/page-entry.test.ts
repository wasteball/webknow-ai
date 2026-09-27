import { describe, expect, it } from 'vitest';

import { needsPageHost, pageEntryLabel } from '../src/sidepanel/page-entry';

describe('换页入口', () => {
  it('页面已换时即使还留着旧地址，也要先取得读取网页的许可', () => {
    expect(needsPageHost('STALE', 'granted', null)).toBe(true);
    expect(needsPageHost('PERMISSION_REQUIRED', 'missing', null)).toBe(true);
    expect(needsPageHost('READY_TO_START', 'granted', null)).toBe(false);
    expect(needsPageHost('ERROR', 'granted', 'PERMISSION_MISSING')).toBe(true);
    expect(needsPageHost('ERROR', 'granted', 'BAD_OUTPUT')).toBe(false);
  });

  it('还没确认外发时，总结摘要的按钮写明这一下会同时确认', () => {
    expect(pageEntryLabel('summary', false)).toBe('我确认，总结摘要');
    expect(pageEntryLabel('summary', true)).toBe('总结摘要');
    expect(pageEntryLabel('questions', true)).toBe('出几个问题');
    expect(pageEntryLabel('learn', true)).toBe('让它问我');
  });
});
