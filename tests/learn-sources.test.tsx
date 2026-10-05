// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LearningEntry } from '../src/sidepanel/components/LearningEntry';

it('shows retained network provenance on a learning note without a mastery label', () => {
  render(<LearningEntry diagrams={false} entry={{
    role: 'note', text: '经核验的补充说明。', at: 1,
    supplement: {
      text: '经核验的补充说明。', source: 'network',
      references: [{ sourceId: 'sr_official', title: '官方说明', url: 'https://example.org/policy',
        domain: 'example.org', publishedAt: null, retrievedAt: '2026-10-05T00:00:00Z', readStatus: 'read' }],
    },
  }} />);
  expect(screen.getByText('补充说明（联网资料）')).toBeTruthy();
  expect(screen.getByRole('link', { name: '官方说明' }).getAttribute('href')).toBe('https://example.org/policy');
  expect(screen.getAllByText('经核验的补充说明。')).toHaveLength(1);
  expect(screen.queryByText('已能独立说明')).toBeNull();
});
