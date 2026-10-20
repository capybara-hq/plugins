/**
 * 可中止的等待：`ms` 到或 signal 中止时 resolve（调用方按需再 `signal.throwIfAborted()`）。只用于本次调用内
 * （长连接循环、通讯录限流退避），随 signal 结束。插件不能用 setTimeout（`pnpm check:plugin-state` 的
 * plugin-timer 规则），所以用 `AbortSignal.timeout` 计时；不建 `AbortSignal.any` 组合信号（每秒一次的状态轮询会
 * 不断在 signal 上挂依赖），两个监听都在结束时摘掉。
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
