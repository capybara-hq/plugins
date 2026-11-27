// The daemon's process entry (bundled as dist/service/daemon.mjs): the provider runs
// `node <state>/daemon.mjs` with CAPYBARA_SERVICE_SOCKET and CAPYBARA_SERVICE_STATE set.

import { DEVICE_SERVICE_SOCKET_ENV, DEVICE_SERVICE_STATE_ENV } from "@capybara-hq/plugin-sdk";
import { type Daemon, startDaemon } from "./main.js";

async function main(): Promise<void> {
  const socketPath = process.env[DEVICE_SERVICE_SOCKET_ENV];
  const stateDir = process.env[DEVICE_SERVICE_STATE_ENV];
  if (!socketPath || !stateDir) {
    process.stderr.write(
      `browser daemon: ${DEVICE_SERVICE_SOCKET_ENV} and ${DEVICE_SERVICE_STATE_ENV} must be set\n`,
    );
    process.exit(2);
  }

  let daemon: Daemon | undefined;
  let stopping = false;
  const stop = (code: number, why: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`browser daemon: stopping (${why})\n`);
    const done = daemon?.close() ?? Promise.resolve();
    done.finally(() => process.exit(code));
  };
  process.on("SIGTERM", () => stop(0, "SIGTERM"));
  process.on("SIGINT", () => stop(0, "SIGINT"));

  daemon = await startDaemon({
    socketPath,
    stateDir,
    env: process.env,
    onIdle: () => stop(0, "idle"),
    // the daemon stays: the next request or viewer launches Chromium again
    onBrowserGone: () =>
      process.stderr.write(
        "browser daemon: Chromium exited unexpectedly; relaunched on next use\n",
      ),
    // installed and sealed: the next start runs the browser read only
    onSealed: () => stop(0, "browser installed and sealed; restart to run it"),
  });
  process.stderr.write(`browser daemon: listening on ${socketPath}\n`);
  daemon.ready.then(
    () => process.stderr.write("browser daemon: Chromium is running\n"),
    // the daemon stays up: every request answers the cause and launches Chromium again
    (e: unknown) => {
      process.stderr.write(
        `browser daemon: Chromium could not start (retried on use): ${String(e)}\n`,
      );
    },
  );
}

await main();
