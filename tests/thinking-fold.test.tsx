// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Thinking } from '../src/sidepanel/components/bits';

describe('思考过程折叠', () => {
  it('有内容时默认折叠，点开后再点可以合上', () => {
    render(<Thinking text="先看前提" />);
    const details = screen.getByText('思考过程').closest('details');
    expect(details).toBeTruthy();
    expect((details as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByText('思考过程'));
    expect((details as HTMLDetailsElement).open).toBe(true);
    fireEvent.click(screen.getByText('思考过程'));
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(details?.textContent).toContain('先看前提');
  });

  it('没有内容时不出现这一项', () => {
    render(<Thinking text="  " />);
    expect(screen.queryByText('思考过程')).toBeNull();
  });
});
