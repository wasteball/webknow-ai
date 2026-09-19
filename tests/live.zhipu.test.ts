import { describe, expect, it } from 'vitest';

import { chatJson } from '../src/core/model-call';
import { findProvider } from '../src/core/model-providers';
import { appError, type AppError } from '../src/core/errors';

/**
 * 智谱真实接入（默认跳过，需显式提供 Key）：
 *
 *   ZHIPU_KEY=xxxx.xxxx pnpm vitest run tests/live.zhipu.test.ts
 *
 * 会真实调用智谱并产生少量费用，因此不进 `pnpm test` 的常规门禁。
 * Key 只从环境变量读取，不写入任何文件。
 *
 * 这条用例对两种账号状态都成立，所以充值前后都能跑：
 * - 账号有余额：验证真实产出能通过我们的 JSON 契约；
 * - 账号没余额：验证它被**正确地**归类成「余额不足」而不是「限流」——
 *   2026-09-19 实测智谱用 HTTP 429 + code 1113 表示余额不足，
 *   只看状态码会告诉用户"等一两分钟再试"，然后他会一直等下去。
 */
const key = process.env.ZHIPU_KEY ?? '';
const live = key ? describe : describe.skip;

const provider = findProvider('zhipu');

const messages = [
  { role: 'system' as const, content: '你只返回 JSON。' },
  { role: 'user' as const, content: '返回 {"ok":true}，不要任何别的内容。' },
];

live('智谱真实接入', () => {
  // 真实调用要几秒，vitest 默认 5 秒会误判超时（先前就误判过一次）。
  it('端点、鉴权头与请求体形状被接受', { timeout: 90_000 }, async () => {
    let failure: AppError | null = null;
    let parsed: unknown = null;
    try {
      parsed = await chatJson({
        apiKey: key,
        provider,
        model: provider.defaultModel,
        messages,
        signal: AbortSignal.timeout(60_000),
        maxTokens: 256,
      });
    } catch (error) {
      failure = error as AppError;
    }

    // 无论哪种结果，都不能是"钥匙不对"——那说明端点或鉴权头写错了。
    if (failure) {
      expect(failure.code).not.toBe('KEY_INVALID');
      expect(failure.code).not.toBe('NETWORK');
      // 余额不足是账号状态，不是集成缺陷；如实记录，不当作失败。
      if (failure.code === 'INSUFFICIENT_BALANCE') {
        process.stdout.write('\n[智谱] 账号余额不足 → 归类为 INSUFFICIENT_BALANCE（正确），本次只验证到鉴权与请求形状。\n');
        return;
      }
      throw appError(failure.code, `意外失败：${failure.message}`);
    }

    // 有余额时：真实产出必须能过我们的 JSON 契约。
    process.stdout.write(`\n[智谱] 真实调用成功，产出：${JSON.stringify(parsed)}\n`);
    expect(parsed).toMatchObject({ ok: true });
  });
});
