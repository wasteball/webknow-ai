// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('../src/sidepanel/components/Rich', async (load) => {
  const real = await load<typeof import('../src/sidepanel/components/Rich')>();
  return { ...real, Rich: (props: { text: string }) => {
    if (props.text.includes('坏掉')) throw new Error('render failed');
    return <real.Rich {...(props as Parameters<typeof real.Rich>[0])} />;
  } };
});

import { Reading } from '../src/sidepanel/components/Reading';
import { panel } from './helpers/panel';

const turn = (id: string, answer: string) => ({ id, question: `问题${id}`, answer, source: 'original' as const,
  citations: [], references: [], unanswered: [], at: 1 });

it('一条回答渲染出错只影响这一条，前后的对话照常显示', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<Reading state={panel({ chat: [turn('1', '前面的回答'), turn('2', '坏掉的回答'), turn('3', '后面的回答')] })} send={vi.fn()} />);
  expect(screen.getByText('前面的回答')).toBeTruthy();
  expect(screen.getByText('后面的回答')).toBeTruthy();
  expect(screen.getByText('这一条没能显示出来，其它对话不受影响。')).toBeTruthy();
});
