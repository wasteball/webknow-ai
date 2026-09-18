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

/** DeepSeek 的 HTTP 状态 → 产品错误类别（FR-021 要求至少区分这五类）。 */
export function fromHttpStatus(status: number): AppError {
  switch (status) {
    case 401:
      return appError('KEY_INVALID', 'DeepSeek 说这把钥匙不对，可能填错了或已经作废。到设置里换一把就行。', false);
    case 402:
      return appError(
        'INSUFFICIENT_BALANCE',
        '你的 DeepSeek 账号余额不够了。去 DeepSeek 充值后就能继续；这一页的内容和刚才的对话都还在。',
        true,
      );
    case 429:
      return appError(
        'RATE_LIMITED',
        'DeepSeek 现在太忙了（同一时间用的人太多）。等一两分钟再试就行，我们不会背着你反复重试。',
        true,
      );
    case 400:
    case 404:
      return appError(
        'UNSUPPORTED_MODEL',
        'DeepSeek 不认我们发的请求格式。这是我们这边的问题，不是你的设置问题；内容都还在，麻烦反馈一下。',
        false,
      );
    case 422:
      return appError('BAD_OUTPUT', 'DeepSeek 说这次请求的参数不对，没有生成结果。重试一次通常就行。', true);
    default:
      if (status >= 500) {
        return appError('SERVICE', 'DeepSeek 那边暂时出故障了。你的内容都还在，过一会儿再试。', true);
      }
      return appError('SERVICE', `DeepSeek 回了一个我们没见过的状态（${status}），结果没采用。可以稍后再试。`, true);
  }
}

/** 网络层失败（没有 HTTP 状态时）。 */
export function fromNetworkFailure(reason: 'offline' | 'cors' | 'unknown'): AppError {
  if (reason === 'offline') {
    return appError('NETWORK', '网络断了，这一页没有发出去。网络恢复后再试。', true);
  }
  return appError(
    'NETWORK',
    '连不上 DeepSeek，可能是网络不通或被拦截。这次没有结果，稍后再试一次。',
    true,
  );
}
