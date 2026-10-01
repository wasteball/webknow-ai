import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { AGENT_LIMITS } from './agent-limits';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const omitted = new Set(['script', 'style', 'noscript', 'iframe', 'form', 'template', 'nav', 'header', 'footer', 'aside', 'svg', 'canvas']);
const blocks = new Set(['p', 'div', 'article', 'main', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br', 'tr', 'blockquote', 'pre']);
function children(node: Node): Node[] { return 'childNodes' in node ? node.childNodes : []; }
function attr(node: Element, name: string): string | undefined { return node.attrs.find(a => a.name === name)?.value; }
function hidden(node: Element): boolean {
  return attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true' ||
    /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr(node, 'style') ?? '') ||
    /^(navigation|banner|contentinfo|complementary)$/.test(attr(node, 'role') ?? '');
}
function collect(root: Node): string {
  // Iterative traversal also tolerates deeply nested hostile HTML in a worker.
  const output: string[] = [];
  const stack: (Node | string)[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node === 'string') { output.push(node); continue; }
    if (node.nodeName === '#text') { output.push((node as DefaultTreeAdapterMap['textNode']).value); continue; }
    if ('tagName' in node) {
      if (omitted.has(node.tagName) || hidden(node)) continue;
      if (blocks.has(node.tagName)) { output.push('\n'); stack.push('\n'); }
    }
    const nodes = children(node);
    for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i]!);
  }
  return output.join('').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t\r\f]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n+/g, '\n').trim();
}

function loginForm(node: Element): boolean {
  // Inspect before form pruning: passwordless email-link and SSO gates still require authentication.
  const indicators = ['action', 'id', 'class', 'name', 'aria-label'].map(name => attr(node, name) ?? '').join(' ');
  if (/(?:^|[\s/_-])(?:login|log-in|sign-in|signin|sso|oauth|auth|authenticate)(?:$|[\s/?#_-])/i.test(indicators)) return true;
  const text = children(node).map(collect).join(' ');
  if (/\b(?:sign[ -]?in|log[ -]?in|sso|magic link)\b|登录|登入|(?:continue|sign in) with (?:google|microsoft|apple|github|facebook)/i.test(text)) return true;
  const stack = children(node).slice();
  while (stack.length) {
    const child = stack.pop()!;
    if ('tagName' in child && child.tagName === 'input' && (
      /^(username|current-password)$/i.test(attr(child, 'autocomplete') ?? '') ||
      /sign[ -]?in|log[ -]?in|登录/i.test(attr(child, 'value') ?? '')
    )) return true;
    for (const descendant of children(child)) stack.push(descendant);
  }
  return false;
}

/** Keep date precision; a calendar date is never a fabricated UTC instant. */
export function sourcePublishedAt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year!, month! - 1, day!));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month! - 1 || check.getUTCDate() !== day) return null;
  if (value.length === 10) return value;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Common short challenge pages may arrive as markdown/plain text without form markup. */
export function sourceAccessWarningText(text: string): string | null {
  if (text.length > 500) return null;
  if (/verify (?:that )?you are human|complete (?:the )?captcha|人机验证|请.{0,8}验证码/i.test(text)) return 'source_captcha_page';
  if (/(?:sign in|log in|login) to (?:continue|view|access)|(?:请先|需要)登录|登录后.{0,8}(?:继续|查看)/i.test(text)) return 'source_login_page';
  return null;
}

/** Pure parse5 tree walk: never creates DOM, executes scripts or fetches subresources.
 * Result remains untrusted source data; removing markup cannot remove semantic injection. */
export function extractSourceHtml(html: string, maxChars: number): { text: string; publishedAt: string | null; warnings: string[] } {
  const document = parse(html);
  const stack: { node: Node; visible: boolean }[] = [{ node: document, visible: true }];
  let article: Element | undefined;
  let main: Element | undefined;
  let body: Element | undefined;
  let publishedAt: string | null = null;
  let accessWarning: string | undefined;
  while (stack.length) {
    const { node, visible } = stack.pop()!;
    let childVisible = visible;
    if ('tagName' in node) {
      const tag = node.tagName;
      if (tag === 'form' && loginForm(node)) accessWarning = 'source_login_page';
      if (tag === 'input' && attr(node, 'type')?.toLowerCase() === 'password') accessWarning = 'source_login_page';
      if (/\b(?:g-recaptcha|h-captcha|cf-turnstile|captcha)\b/i.test(`${attr(node, 'class') ?? ''} ${attr(node, 'id') ?? ''}`) ||
          (tag === 'title' && /verify (?:that )?you are human|just a moment|验证码|人机验证/i.test(collect(node)))) accessWarning = 'source_captcha_page';
      const publication = tag === 'meta' && /^(article:published_time|datepublished|pubdate)$/i.test(attr(node, 'property') ?? attr(node, 'name') ?? attr(node, 'itemprop') ?? '')
        ? attr(node, 'content') : tag === 'time' && /\bdatePublished\b/i.test(attr(node, 'itemprop') ?? '') ? attr(node, 'datetime') : undefined;
      publishedAt ??= sourcePublishedAt(publication);
      childVisible = visible && !omitted.has(tag) && !hidden(node);
      if (childVisible && tag === 'article') article ??= node;
      if (childVisible && tag === 'main') main ??= node;
      if (childVisible && tag === 'body') body = node;
    }
    // Access-gate inspection must also visit form children excluded from readable text.
    const nodes = children(node);
    for (let i = nodes.length - 1; i >= 0; i--) stack.push({ node: nodes[i]!, visible: childVisible });
  }
  if (accessWarning) return { text: '', publishedAt: null, warnings: [accessWarning] };
  const text = collect(article ?? main ?? body ?? document);
  const challenge = sourceAccessWarningText(text);
  if (challenge) return { text: '', publishedAt: null, warnings: [challenge] };
  const limit = Math.max(0, Math.min(AGENT_LIMITS.sourceChars, Number.isFinite(maxChars) ? Math.floor(maxChars) : 0));
  return { text: text.slice(0, limit), publishedAt, warnings: text.length > limit ? ['source_text_truncated'] : [] };
}
