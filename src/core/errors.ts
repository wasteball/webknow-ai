/**
 * 错误类别与用户可执行动作（FR-021/FR-035）。
 *
 * 错误消息回答四件事：发生了什么、影响什么、什么仍可用、下一步是什么。
 */
export type ErrorCode =
  // DeepSeek 接入
  | 'NO_KEY'
  | 'KEY_INVALID'
  | 'INSUFFICIENT_BALANCE'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED_MODEL'
  | 'NETWORK'
  | 'SERVICE'
  | 'TIMEOUT'
  | 'ABORTED'
  // 页面与正文
  | 'PAGE_UNSUPPORTED'
  | 'PERMISSION_MISSING'
  | 'EXTRACT_FAILED'
  | 'CONTENT_TOO_LARGE'
  | 'STALE_PAGE'
  | 'JUMP_FAILED'
  // 会话与输出
  | 'BUSY'
  | 'BAD_OUTPUT'
  | 'BUDGET_EXCEEDED'
  | 'STORAGE_FAILED'
  | 'SEARCH_FAILED'
  | 'IMA_FAILED'
  | 'INTERNAL';

export type AppError = {
  code: ErrorCode;
  message: string;
  /** 是否值得用户重试（程序不会无限重试，见 LIMITS.maxRetries）。 */
  retryable: boolean;
};

export function appError(code: ErrorCode, message: string, retryable = false): AppError {
  return { code, message, retryable };
}

/** 未分类异常统一落到 INTERNAL，且不向界面暴露堆栈或正文。 */
export function fromThrown(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return appError('ABORTED', '已经按你的要求停下来了。');
  }
  return appError('INTERNAL', '中间出了点我们没预料到的问题，这次结果没有采用。可以再试一次。');
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AppError).code === 'string' &&
    typeof (value as AppError).message === 'string'
  );
}

/**
 * 供应商返回的错误码 → 余额不足。**不能只看 HTTP 状态**：
 * 429 在 DeepSeek 是"用的人太多"，在智谱却是"余额不足或无可用资源包"（code 1113）。
 * 按状态一刀切会让没钱的用户被告知"等一两分钟再试"，然后一直等下去。
 */
const BALANCE_CODES = new Set(['1113', '1112', '1114']);

/** 正文里的余额字样兜底：各家码表会变，文案比状态码稳定一点。 */
const BALANCE_WORDS = /余额|充值|欠费|insufficient|balance|quota|credit/i;

export type HttpFailureHint = {
  /** 用哪家供应商发出去的——错误文案要说清是谁拒绝的。 */
  providerName: string;
  /** 供应商错误正文里的机器码（可选）。 */
  code?: string;
  /** 供应商错误正文里的一句话（可选，只用于分类判断，不进界面）。 */
  detail?: string;
};

/** HTTP 状态 + 供应商错误码 → 产品错误类别（FR-021 要求至少区分这五类）。 */
export function fromHttpStatus(status: number, hint?: HttpFailureHint): AppError {
  const who = hint?.providerName ?? '模型供应商';
  const saysBalance =
    (hint?.code !== undefined && BALANCE_CODES.has(hint.code)) ||
    (hint?.detail !== undefined && BALANCE_WORDS.test(hint.detail));

  switch (status) {
    case 401:
      return appError('KEY_INVALID', `${who}说这把钥匙不对，可能填错了或已经作废。到设置里换一把就行。`, false);
    case 402:
      return appError(
        'INSUFFICIENT_BALANCE',
        `你的 ${who} 账号余额不够了。去 ${who} 充值后就能继续；这一页的内容和刚才的对话都还在。`,
        true,
      );
    case 429:
      // 同样是 429，两种含义的下一步完全不同：一个去充值，一个等一会儿。
      if (saysBalance) {
        return appError(
          'INSUFFICIENT_BALANCE',
          `你的 ${who} 账号余额不够了。去 ${who} 充值后就能继续；这一页的内容和刚才的对话都还在。`,
          true,
        );
      }
      return appError(
        'RATE_LIMITED',
        `${who}现在太忙了（同一时间用的人太多）。等一两分钟再试就行，我们不会背着你反复重试。`,
        true,
      );
    case 400:
      // 智谱用 400 + 1211 表示模型不存在，这是用户能自己修的。
      if (hint?.code === '1211') {
        return appError(
          'UNSUPPORTED_MODEL',
          `${who}没有这个模型。到设置 → 模型里换一个，或手动填写你的账号能用的模型 ID。`,
          false,
        );
      }
      return appError(
        'UNSUPPORTED_MODEL',
        `${who}不认我们发的请求格式。这是我们这边的问题，不是你的设置问题；内容都还在，麻烦反馈一下。`,
        false,
      );
    case 404:
      return appError(
        'UNSUPPORTED_MODEL',
        `${who}没有这个模型。到设置 → 模型里换一个，或手动填写你的账号能用的模型 ID。`,
        false,
      );
    case 422:
      return appError('BAD_OUTPUT', `${who}说这次请求的参数不对，没有生成结果。重试一次通常就行。`, true);
    default:
      if (status >= 500) {
        return appError('SERVICE', `${who}那边暂时出故障了。你的内容都还在，过一会儿再试。`, true);
      }
      return appError('SERVICE', `${who}回了一个我们没见过的状态（${status}），结果没采用。可以稍后再试。`, true);
  }
}

/** 网络层失败（没有 HTTP 状态时）。 */
export function fromNetworkFailure(reason: 'offline' | 'cors' | 'unknown', providerName = '模型供应商'): AppError {
  if (reason === 'offline') {
    return appError('NETWORK', '网络断了，这一页没有发出去。网络恢复后再试。', true);
  }
  return appError(
    'NETWORK',
    `连不上 ${providerName}，可能是网络不通或被拦截。这次没有结果，稍后再试一次。`,
    true,
  );
}
