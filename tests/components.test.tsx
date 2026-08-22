import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Answer, Coverage } from '../entrypoints/sidepanel/App';
import type { AnswerResult, EvidenceBlock } from '../src/contracts';

const content = '本地保存的原始证据摘录。';
const block: EvidenceBlock = {
  id: 'b-1',
  sessionId: 's-1',
  modality: 'text',
  role: 'paragraph',
  content,
  context: { headingPath: ['结论', '适用范围'] },
  source: { url: 'https://example.test/article', title: '测试文章' },
  anchor: {
    sessionAnchorId: 'a-1',
    selector: '#evidence',
    exact: content,
    prefix: '',
    suffix: '',
    textPosition: { start: 0, end: content.length },
    headingPath: ['结论', '适用范围'],
    fingerprint: 'fp',
  },
  provenance: { parser: 'readability', method: 'retained-anchor' },
  integrity: { fingerprint: 'fp', completeness: 'complete' },
  sourceLevel: 'L1',
};

const completeness = {
  scope: 'readability-article' as const,
  text: { status: 'parsed' as const, found: 1, captured: 1 },
  tables: { status: 'not-present' as const, found: 0, captured: 0 },
  images: { status: 'unavailable' as const, found: 1, captured: 0, note: '未启用视觉模型' },
  excludedAmbiguousBlocks: 0,
  warnings: ['发现 1 张图片；当前版本未解析图片内容。'],
};

function result(status: AnswerResult['status']): AnswerResult {
  return {
    runId: 'r-1',
    sessionId: 's-1',
    question: '问题',
    status,
    conclusion: status === 'INSUFFICIENT' ? '当前资料不足以支持明确结论。' : '已核查结论。',
    claims: [
      {
        id: 'c-1',
        statement: '证据主张',
        importance: 'key',
        status:
          status === 'INSUFFICIENT'
            ? 'insufficient'
            : status === 'CONFLICTED'
              ? 'conflicted'
              : 'supported',
        citations: status === 'INSUFFICIENT' ? [] : [{ blockId: 'b-1', relation: 'supports' }],
      },
    ],
    evidence: status === 'INSUFFICIENT' ? [] : [block],
    unanswered: status === 'INSUFFICIENT' ? ['未验证：证据主张'] : [],
    coverage: { sentBlocks: 1, totalBlocks: 1 },
    completeness,
  };
}

describe('verified answer UI', () => {
  it.each([
    ['SUPPORTED', '证据支持'],
    ['CONFLICTED', '证据冲突'],
    ['INSUFFICIENT', '证据不足'],
  ] as const)('renders an explicit %s verdict', (status, label) => {
    render(<Answer result={result(status)} blocks={new Map([['b-1', block]])} onJump={vi.fn()} />);
    expect(screen.getAllByText(label)[0]).toBeVisible();
  });

  it('renders quotes only from local evidence blocks', () => {
    render(
      <Answer result={result('SUPPORTED')} blocks={new Map([['b-1', block]])} onJump={vi.fn()} />,
    );
    expect(screen.getByText(content)).toBeVisible();
    expect(screen.queryByText('模型伪造的原文摘录')).not.toBeInTheDocument();
  });

  it('keeps unavailable image coverage visible', () => {
    render(
      <Coverage
        session={{
          id: 's-1',
          tabId: 1,
          state: 'READY_PARTIAL',
          page: {
            tabId: 1,
            url: 'https://example.test/article',
            origin: 'https://example.test',
            title: '测试文章',
            kind: 'html',
          },
          fingerprint: 'fp',
          blocks: [block],
          completeness,
          createdAt: 1,
          updatedAt: 1,
        }}
      />,
    );
    const imageCoverage = screen.getByText(/图片未解析/);
    expect(imageCoverage).toBeVisible();
    expect(imageCoverage).toHaveTextContent('1 图片未解析');
    expect(screen.getByText(/当前版本未解析图片内容/)).toBeVisible();
  });
});
