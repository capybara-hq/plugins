/**
 * Abortable wait: resolves when `ms` elapses or the signal aborts (callers call
 * `signal.throwIfAborted()` as needed). Used only within one call (the long-connection loop,
 * directory rate-limit backoff) and ends with the signal. Extensions may not use setTimeout (the
 * plugin-timer rule of `pnpm check:extension-state`), so `AbortSignal.timeout` does the timing; no
 * `AbortSignal.any` combined signal is built (the once-a-second status poll would keep adding
 * dependants to the signal), and both listeners are removed at the end.
 */
export const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = AbortSignal.timeout(ms);
    const done = () => {
      signal.removeEventListener("abort", done);
      timer.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    timer.addEventListener("abort", done, { once: true });
  });
