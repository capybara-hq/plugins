/** The longest retry hint passed on to the kernel (one hour). */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/**
 * `Retry-After` (seconds or an HTTP date) in milliseconds, capped at {@link MAX_RETRY_AFTER_MS};
 * undefined when absent, unparsable, non-finite or negative.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  const v = header?.trim() ?? "";
  if (v === "") return undefined;
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}
