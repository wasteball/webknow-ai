import type { Freshness, GateResult, NetworkMode } from './agent-types';
import { buildTimeContext, calendarDate, shiftCalendarDays, shiftCalendarMonths } from './time';

type RequestedRange = { from: string; to: string };

/** Parse only explicit, deterministic calendar expressions; uncertain scopes ask the user. */
function requestedTime(question: string, today: string): { range?: RequestedRange; freshness?: Freshness; ambiguous?: boolean } {
  if (/年初|年末|前后|一段时间|近期以来|几[天周月年]|上半年|下半年|季度/.test(question)) return { ambiguous: true };
  const absoluteDate = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b|(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  const dates = [...question.matchAll(absoluteDate)]
    .map((match) => `${match[1] ?? match[4]}-${(match[2] ?? match[5])!.padStart(2, '0')}-${(match[3] ?? match[6])!.padStart(2, '0')}`);
  const extraTime = (remainder: string) => /\d+\s*[年月日]|\d{4}[-/]\d|今天|今日|昨天|昨日|本周|这周|上周|本月|这个月|上月|今年|去年|today|yesterday/i.test(remainder);
  if (dates.length) {
    if (extraTime(question.replace(absoluteDate, ''))) return { ambiguous: true };
    if (dates.length > 2 || (dates.length === 2 && !/(?:至|到|~|～|—|\bto\b)/i.test(question))) return { ambiguous: true };
    try { dates.forEach(calendarDate); } catch { return { ambiguous: true }; }
    const range = { from: dates[0]!, to: dates.at(-1)! };
    return range.from <= range.to ? { range, freshness: 'any' } : { ambiguous: true };
  }
  const monthPattern = /(\d{4})\s*(?:年\s*|[-/])(\d{1,2})\s*月?/g;
  const month = [...question.matchAll(monthPattern)][0];
  if (month) {
    if (extraTime(question.replace(month[0], '')) || /\d{4}\/\d+\//.test(question)) return { ambiguous: true };
    const from = `${month[1]}-${month[2]!.padStart(2, '0')}-01`;
    try {
      calendarDate(from);
      return { range: { from, to: shiftCalendarDays(shiftCalendarMonths(from, 1), -1) }, freshness: 'any' };
    } catch { return { ambiguous: true }; }
  }
  const years = [...question.matchAll(/\b(\d{4})\s*年/g)].map((match) => match[1]);
  if (years.length) {
    if (extraTime(question.replace(/\b(\d{4})\s*年/g, ''))) return { ambiguous: true };
    if (years.length > 2 || (years.length === 2 && !/[至到~～—]/.test(question))) return { ambiguous: true };
    const range = { from: `${years[0]}-01-01`, to: `${years.at(-1)}-12-31` };
    return range.from <= range.to ? { range, freshness: 'any' } : { ambiguous: true };
  }
  const relatives = [...question.matchAll(/今天|今日|昨天|昨日|本周|这周|上周|本月|这个月|上月|今年|去年|today|yesterday/gi)];
  if (relatives.length > 1) return { ambiguous: true };
  const relative = relatives[0]?.[0].toLowerCase();
  if (relative) {
    let from = today;
    let to = today;
    if (/昨天|昨日|yesterday/.test(relative)) from = to = shiftCalendarDays(today, -1);
    if (/周/.test(relative)) {
      const weekday = calendarDate(today).getUTCDay() || 7;
      from = shiftCalendarDays(today, 1 - weekday - (relative === '上周' ? 7 : 0));
      if (relative === '上周') to = shiftCalendarDays(from, 6);
    }
    if (/月/.test(relative)) {
      from = `${today.slice(0, 7)}-01`;
      if (relative === '上月') { to = shiftCalendarDays(from, -1); from = shiftCalendarMonths(from, -1); }
    }
    if (/年/.test(relative)) {
      const year = Number(today.slice(0, 4)) - (relative === '去年' ? 1 : 0);
      from = `${year}-01-01`;
      if (relative === '去年') to = `${year}-12-31`;
    }
    // Historical periods use exact bounds only; a current rolling filter would discard their earlier days.
    const freshness: Freshness = /今天|今日|today/.test(relative) ? 'day'
      : /^(本周|这周)$/.test(relative) ? 'week' : /^(本月|这个月)$/.test(relative) ? 'month' : 'any';
    return { range: { from, to }, freshness };
  }
  const rolling = question.match(/(?:过去|最近|近)\s*(\d+)\s*(天|周|个月|月)/);
  if (rolling) {
    const count = Number(rolling[1]);
    if (count < 1 || count > 366) return { ambiguous: true };
    const from = /月/.test(rolling[2]!) ? shiftCalendarMonths(today, -count)
      : shiftCalendarDays(today, 1 - count * (rolling[2] === '周' ? 7 : 1));
    const freshness: Freshness = rolling[2] === '天' && count === 1 ? 'day'
      : (rolling[2] === '天' && count === 7) || (rolling[2] === '周' && count === 1) ? 'week'
        : /月/.test(rolling[2]!) && count === 1 ? 'month' : 'any';
    return { range: { from, to: today }, freshness };
  }
  // Unsupported numeric dates must not silently become a current-time filter.
  if (/\d{4}[-/]\d|\d+\s*月|\d+\s*日|去年|今年|上个|最近\s*[一二三四五六七八九十]/.test(question)) return { ambiguous: true };
  return {};
}

export function evaluateSearchGate(input: {
  question: string; pageTitle: string; quote: string | null; mode: NetworkMode;
  enabled: boolean; freshness: 'auto' | Freshness; now: Date; timeZone: string;
}): GateResult {
  const question = input.question.trim();
  const reasons: string[] = [];
  const explicit = /联网|上网|搜索|查证|事实核查|验证.*(?:作者|说法|事实)|(?:作者|说法).*是否(?:属实|真实|正确)|fact.?check|verify|search (?:online|the web)/i.test(question);
  const articleSubject = /文中|本文|文章|原文|这段|这句话|这篇|划词|作者.*(?:意思|提到|表达|认为|原因)|the article|this (?:passage|paragraph)/i;
  const liveRequest = /今天|今日|现在|最新|当前|实时|最近|today|current|latest|right now/i;
  const separateLiveRequest = question.split(/[,，;；。]/).some((clause) => liveRequest.test(clause) && !articleSubject.test(clause));
  // Explaining quoted time wording is local; asking if its subject is still valid is a current-state check.
  const unquoted = question.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/g, '');
  const currentState = /是否(?:仍然|仍|还)(?:有效|适用|生效)|(?:仍然|仍|还)(?:有效|适用|生效)(?:吗|么|？|\?)/.test(unquoted)
    || (liveRequest.test(unquoted)
      && /是否(?:仍然|仍|还)?(?:有效|适用|生效|是最新)|是不是(?:最新|有效)|(?:现在|当前|今天|今日).*(?:有效|适用|生效|价格|版本)/.test(unquoted));
  // Time words in an attributed premise do not turn a request for the author's reasoning into verification.
  const attributedReasoning = /^(?:请)?(?:解释|说明|梳理|总结)(?:一下)?作者(?:认为|说|称|指出)[^,，;；。?!？！]*(?:的原因|的理由)[。？?]?$/.test(question);
  const article = /解释|总结|概括|核对|梳理|翻译|说明|explain|summari[sz]e|translate/i.test(question)
    && articleSubject.test(question) && !separateLiveRequest && (!currentState || attributedReasoning);
  const live = liveRequest.test(question) || currentState;
  const missingEntity = /(?:那|这)(?:家|个)(?:公司|产品|软件|政策)|^(?:请问|请|查一下|搜索)?\s*(?:今天|现在|最新|当前|最近)?\s*(?:的)?\s*(?:版本|价格|政策|情况|消息)\s*(?:是|有|为|多少|什么|怎样|如何|怎么样|？|\?)/.test(question)
    || /^(?:what(?:'s| is) (?:the )?)?(?:latest version|current price)[?\s]*$/i.test(question);
  let level: GateResult['level'];
  if (article && !explicit) { level = 'not_needed'; reasons.push('本轮只处理文章内容；文中的时间词不是实时检索请求。'); }
  else if (missingEntity) { level = 'ambiguous'; reasons.push('缺少可确定的主体，先澄清实体及必要的地区。'); }
  else if (explicit || live) { level = 'required'; reasons.push(explicit ? '用户明确要求外部查证或检索。' : '本轮需要核验当前或最新事实。'); }
  else if (/背景|比较|对比|外部|资料|\d{4}\s*年|政策|价格|版本|background|compare/i.test(question)) {
    level = 'recommended'; reasons.push('问题涉及文章外事实或补充资料。');
  } else { level = 'ambiguous'; reasons.push('无法确定是否只围绕文章，先澄清信息范围。'); }

  const baseTime = buildTimeContext(input.now, input.timeZone, 'any');
  const temporal = level === 'not_needed' ? {} : requestedTime(question, baseTime.localDate);
  let freshness: Freshness = live && level !== 'not_needed' ? 'live' : input.freshness === 'auto' ? 'any' : input.freshness;
  if (temporal.freshness) freshness = temporal.freshness;
  if (temporal.ambiguous) { level = 'ambiguous'; freshness = 'any'; reasons.push('时间范围不明确或日期无效，先澄清而不伪造范围。'); }
  let time = baseTime;
  try { time = buildTimeContext(input.now, input.timeZone, freshness, temporal.range); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    level = 'ambiguous'; freshness = 'any'; reasons.push('日期范围在给定时区无效，先澄清。');
  }
  if (input.mode === 'force') {
    if (level !== 'ambiguous') level = 'required';
    reasons.push('用户本轮明确选择必须联网；存在歧义时先澄清，再履行搜索前提。');
  }
  if (!input.enabled) reasons.push('全局联网关闭，不能执行搜索。');
  if (input.mode === 'article') reasons.push('本轮只依据文章，不执行搜索。');
  const canSearch = input.enabled && input.mode !== 'article' && level !== 'not_needed';
  return { level, canSearch, mustSearch: canSearch && (level === 'required' || input.mode === 'force'), freshness, time, reasons };
}
