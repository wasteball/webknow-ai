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
    return appError('ABORTED', '已停止本次处理。');
  }
  return appError('INTERNAL', '处理过程中出现未预期的问题，本次结果未采用。可重试或稍后再试。');
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
      return appError('KEY_INVALID', 'DeepSeek 拒绝了当前 Key。请更新 Key 后重试。', false);
    case 402:
      return appError(
        'INSUFFICIENT_BALANCE',
        'DeepSeek 账户余额不足。请前往 DeepSeek 充值后重试；当前页面与会话内容仍保留。',
        true,
      );
    case 429:
      return appError('RATE_LIMITED', 'DeepSeek 当前限流。稍后重试即可，界面不会自动反复重试。', true);
    case 400:
    case 404:
      return appError(
        'UNSUPPORTED_MODEL',
        'DeepSeek 拒绝了本次请求的格式或模型名。这是产品配置问题，已保留当前内容，请反馈。',
        false,
      );
    case 422:
      return appError('BAD_OUTPUT', 'DeepSeek 认为本次请求参数无效，未产生费用结果。请重试。', true);
    default:
      if (status >= 500) {
        return appError('SERVICE', 'DeepSeek 服务暂时不可用。已保留当前内容，可稍后重试。', true);
      }
      return appError('SERVICE', `DeepSeek 返回了未预期的状态（${status}）。本次结果未采用。`, true);
  }
}

/** 网络层失败（没有 HTTP 状态时）。 */
export function fromNetworkFailure(reason: 'offline' | 'cors' | 'unknown'): AppError {
  if (reason === 'offline') {
    return appError('NETWORK', '当前网络不可用，正文没有发送成功。恢复网络后可重试。', true);
  }
  return appError(
    'NETWORK',
    '连接 DeepSeek 失败。可能是网络或拦截问题；本次没有产生可用结果，可稍后重试。',
    true,
  );
}
