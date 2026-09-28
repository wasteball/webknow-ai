import { describe, expect, it } from 'vitest';

import { needsPageHost, pageEntryLabel } from '../src/sidepanel/page-entry';

describe('换页入口', () => {
  it('换页后已有新页工具栏授权时不用重复申请，否则才请求网页权限', () => {
    expect(needsPageHost('granted', null)).toBe(false);
    expect(needsPageHost('missing', null)).toBe(true);
    expect(needsPageHost('unknown', null)).toBe(true);
    expect(needsPageHost('granted', 'PERMISSION_MISSING')).toBe(true);
    expect(needsPageHost('granted', 'BAD_OUTPUT')).toBe(false);
  });

  it('还没确认外发时，每个阅读入口都写明这一下会同时确认', () => {
    expect(pageEntryLabel('summary', false)).toBe('我确认，总结摘要');
    expect(pageEntryLabel('questions', false)).toBe('我确认，出几个问题');
    expect(pageEntryLabel('learn', false)).toBe('我确认，让它问我');
    expect(pageEntryLabel('summary', true)).toBe('总结摘要');
    expect(pageEntryLabel('questions', true)).toBe('出几个问题');
    expect(pageEntryLabel('learn', true)).toBe('让它问我');
  });
});
