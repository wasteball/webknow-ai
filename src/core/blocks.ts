import { appError, type AppError } from './errors';
import { LIMITS } from './limits';

/**
 * 原文块：模型只能引用这些块的 id，直接引文一律由程序从本地块取出（FR-016）。
 * 这里只保留“可信底座”需要的字段，不含旧版的多模态/溯源字段。
 */
export type BlockRole = 'heading' | 'paragraph' | 'list-item' | 'table-cell' | 'image';

export type DomAnchor = {
  /** 提取时写在页面元素上的锚点属性值，用于回跳优先命中。 */
  sessionAnchorId: string;
  selector: string;
  exact: string;
  prefix: string;
  suffix: string;
  headingPath: string[];
  fingerprint: string;
};

export type EvidenceBlock = {
  id: string;
  role: BlockRole;
  content: string;
  headingPath: string[];
  table?: { caption?: string; column?: string; row?: string };
  anchor: DomAnchor;
};

/** 提取时记下的内容图。字节不进会话，只留地址和锚点，读图结果另写成 image 块。 */
export type PictureRef = {
  id: string;
  url: string;
  alt: string;
  anchor: DomAnchor;
  /** 插到这个正文块后面；没有则排在正文前面。 */
  afterBlockId?: string;
};

/** 读取范围披露：图片/表格/无法定位的块必须可见（FR-018）。 */
export type CoverageStatus = 'parsed' | 'partial' | 'not-present' | 'unavailable';
export type Coverage = { status: CoverageStatus; found: number; captured: number };

export type Completeness = {
  scope: 'readability-article' | 'page-text';
  textRange?: {
    characters: number;
    first: { blockId: string; text: string; jumpable?: boolean };
    last: { blockId: string; text: string; jumpable?: boolean };
  };
  text: Coverage;
  tables: Coverage;
  images: Coverage;
  /** 内嵌框架（iframe）：跨来源的读不到，必须披露。 */
  frames: Coverage;
  /** 读进证据了、但没法点回原文的块数。 */
  excludedBlocks: number;
  /** 是否因上限缩小了读取范围（为 true 时不得声称覆盖全文）。 */
  truncated: boolean;
  warnings: string[];
};

/** 回跳结果：failed 必须带原因，界面据此展示失效而不是假装成功（FR-017）。 */
export type JumpOutcome =
  | { outcome: 'jumped' }
  | { outcome: 'relocated' }
  | { outcome: 'failed'; reason: string };

export type BlocksPayload = {
  title: string;
  url: string;
  fingerprint: string;
  blocks: EvidenceBlock[];
  completeness: Completeness;
  /** 这一页的内容图。还没读过时由后台补成 image 块。 */
  pictures?: PictureRef[];
};

export type ContextResult =
  | { ok: true; json: string; sentBlocks: number; totalBlocks: number }
  | { ok: false; error: AppError };

/**
 * 组装发送给模型的正文上下文；超限时明确失败，不做静默截断（FR-018/FR-039）。
 * 正文以 JSON 数据块形式给出，永远不作为指令（FR-034）。
 */
export function buildContext(blocks: EvidenceBlock[]): ContextResult {
  if (blocks.length > LIMITS.maxBlocks) {
    return {
      ok: false,
      error: appError(
        'CONTENT_TOO_LARGE',
        `这一页太长了，超过了目前能可靠处理的范围。我们没有偷偷截断，也没有把正文发出去。可以换一篇短一点的文章。`,
      ),
    };
  }
  const payload = blocks.map((block) => ({
    id: block.id,
    role: block.role,
    content: block.content,
    headingPath: block.headingPath,
    table: block.table,
  }));
  const json = JSON.stringify(payload);
  if (json.length > LIMITS.maxContextChars) {
    return {
      ok: false,
      error: appError(
        'CONTENT_TOO_LARGE',
        `这一页的文字太多了（超过约 ${Math.round(LIMITS.maxContextChars / 10000)} 万字），超出目前能可靠处理的范围。我们没有偷偷截断，也没有把正文发出去。可以换一篇短一点的文章。`,
      ),
    };
  }
  return { ok: true, json, sentBlocks: blocks.length, totalBlocks: blocks.length };
}

/** 取回本地原文用于直接引文与回跳；块不存在时返回 undefined，绝不编造文本。 */
export function quoteFrom(blocks: EvidenceBlock[], blockId: string): string | undefined {
  return blocks.find((block) => block.id === blockId)?.content;
}

/**
 * 把读取范围转成给模型和用户都看得懂的一句话（FR-018）。
 * 未解析的图片、表格与无法定位的块必须出现在这里，也不得被摘要声称覆盖。
 */
export function describeCompleteness(completeness: Completeness): string {
  const text = completeness.text;
  const body = completeness.scope === 'page-text'
    ? '按当前加载的页面文字读取，未确认完整文章'
    : text.status === 'partial' || completeness.truncated
      ? '只读取到当前加载的部分正文'
      : text.captured > 0 ? '已读取当前加载的正文' : '尚未读取到可用正文';
  const characters = completeness.textRange?.characters;
  const parts = [body + (characters ? `（约 ${characters} 字）` : '')];
  if (completeness.tables.found > 0) {
    parts.push(completeness.tables.status === 'parsed' ? '表格文字已读取' : '表格只读取到部分文字');
  }
  const { found, captured } = completeness.images;
  if (found > 0) {
    if (captured > 0) parts.push(`图片已转述 ${captured}/${found} 张（模型转述，可能有误，并非作者原话）`);
    if (found > captured) parts.push(`${found - captured} 张图片未读`);
  }
  const framesUnread = completeness.frames.found - completeness.frames.captured;
  if (framesUnread > 0) parts.push(`${framesUnread} 个跨来源内嵌页面未读取`);
  if (completeness.excludedBlocks > 0) parts.push('部分内容已读取，但无法回到页面位置');
  if (completeness.truncated) parts.push('本次没有覆盖全文');
  for (const warning of new Set(completeness.warnings)) {
    if (warning === '有的图片没读到。' && found > captured) continue;
    if (completeness.scope === 'page-text' && warning.startsWith('这一页不太像完整文章')) continue;
    parts.push(warning.replace('当前这家读不了图。', '当前模型不支持读图。'));
  }
  return parts.join('；');
}
