import { type LarkApi, LarkApiError, type LarkCredentials } from "./api.js";
import { describeError } from "./errors.js";
import { pause } from "./wait.js";

/** 一次操作（如通讯录的一页、一次 verify）内按 `x-ogw-ratelimit-reset` 累计等待的剩余预算。 */
export interface RateLimitBudget {
  leftMs: number;
}

/** 默认的等待预算（每次操作 30 秒）与每个请求的最多重试次数。 */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 30_000;
export const DEFAULT_RATE_LIMIT_RETRIES = 3;

export const newBudget = (ms = DEFAULT_RATE_LIMIT_WAIT_MS): RateLimitBudget => ({ leftMs: ms });

/**
 * 带 tenant token 的 GET，遇到限流（HTTP 429 或 `99991400`，
 * https://open.larksuite.com/document/ukTMukTMukTM/uUzN04SN3QjL1cDN ，2026-10-20 查阅）时按 `x-ogw-ratelimit-reset`
 * （没有则 1 秒）在 signal 内等待后重试；最多 `maxRetries` 次，且累计等待不超过 `budget`，超出就抛
 * 「<步骤> rate limited」。其他错误经 {@link describeError}（只带步骤与错误码，`cause` 为原错误）抛出。
 * signal 中止时以其原因拒绝。
 */
export async function getWithBackoff(
  api: LarkApi,
  creds: LarkCredentials,
  path: string,
  o: {
    query?: Record<string, string>;
    what: string;
    signal: AbortSignal;
    budget: RateLimitBudget;
    maxRetries?: number;
  },
): Promise<Record<string, unknown>> {
  const maxRetries = o.maxRetries ?? DEFAULT_RATE_LIMIT_RETRIES;
  for (let attempt = 0; ; attempt++) {
    o.signal.throwIfAborted();
    try {
      return await api.call<Record<string, unknown>>(creds, path, {
        ...(o.query !== undefined && { query: o.query }),
        signal: o.signal,
      });
    } catch (e) {
      o.signal.throwIfAborted();
      if (e instanceof LarkApiError && (e.status === 429 || e.code === 99991400)) {
        const waitMs = e.retryAfterMs ?? 1000;
        if (attempt >= maxRetries || waitMs > o.budget.leftMs) {
          throw new Error(
            `Lark ${o.what} rate limited (retry after ${waitMs / 1000}s); the sync will be retried later`,
            { cause: e },
          );
        }
        o.budget.leftMs -= waitMs;
        await pause(waitMs, o.signal);
        continue;
      }
      throw describeError(e, o.what);
    }
  }
}
