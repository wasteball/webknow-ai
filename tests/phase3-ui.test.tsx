// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { PageImages, Rich } from '../src/sidepanel/components/Rich';
import { SaveButton } from '../src/sidepanel/components/bits';

const pictures = {
  resolve: (id: string) => (['img_0', 'img_1', 'img_2'].includes(id)
    ? { src: `https://cdn.example.com/${id}.png`, alt: id, blockId: id } : undefined),
  onJump: vi.fn(),
};

it('回答里只显示 AI 读过的本页原图，最多两张，点了回到网页上的位置', () => {
  render(<PageImages.Provider value={pictures}>
    <Rich text={'看图 ![一](img:img_0) ![二](img:img_1) ![三](img:img_2) ![编的](img:img_9) ![外链](https://evil.example/x.png)'} />
  </PageImages.Provider>);
  const images = screen.getAllByRole('img');
  expect(images.map((img) => img.getAttribute('src'))).toEqual(['https://cdn.example.com/img_0.png', 'https://cdn.example.com/img_1.png']);
  fireEvent.click(images[0]!.closest('button')!);
  expect(pictures.onJump).toHaveBeenCalledWith('img_0');
});

it('题干等不允许出图的位置不显示图片', () => {
  render(<PageImages.Provider value={pictures}><Rich text={'![一](img:img_0)'} pictures={false} /></PageImages.Provider>);
  expect(screen.queryByRole('img')).toBeNull();
});

it('收藏：已连接时一点即存并说明存到了哪里；没连接时去连接', async () => {
  const send = vi.fn(async () => ({ ok: true as const, message: '已存到「读书笔记」：网页和阅读笔记。' }));
  const { rerender } = render(<SaveButton connected kbName="读书笔记" tabId={7} send={send} />);
  fireEvent.click(screen.getByRole('button', { name: /收藏到知识库/ }));
  await waitFor(() => expect(screen.getByText('已存到「读书笔记」：网页和阅读笔记。')).toBeTruthy());
  expect(send).toHaveBeenCalledWith({ type: 'saveToIma', tabId: 7 });

  const connect = vi.fn();
  rerender(<SaveButton connected={false} kbName={null} tabId={7} send={send} onConnect={connect} />);
  fireEvent.click(screen.getByRole('button', { name: /连接知识库后收藏/ }));
  expect(connect).toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
});
