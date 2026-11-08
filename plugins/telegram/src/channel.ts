import type { Channel, ExtensionContext, Logger } from "@capybara-hq/plugin-sdk";
import { TelegramConnection } from "./config.js";

export interface TelegramChannelOptions {
  /** Bot API root (default https://api.telegram.org; tests point it at the fake). */
  apiUrl: string;
  log: Logger;
  /** Plugin kv (`ctx.kv`): the long-polling offset and thread records, keyed by bot id. */
  kv?: ExtensionContext["kv"];
  /** One Bot API request's timeout (default 15 s). */
  requestTimeoutMs?: number;
  /** The `getUpdates` long-poll timeout (default 25 s). */
  pollTimeoutSec?: number;
  /** Base of the network-error backoff (tests lower it). */
  backoffBaseMs?: number;
}

/** Stub: Task 7 implements verify / connect / send / update. */
export function createTelegramChannel(_o: TelegramChannelOptions): Channel {
  const notImplemented = () => {
    throw new Error("not implemented");
  };
  return {
    connectionSchema: TelegramConnection,
    features: { cards: true, edit: true, threads: true, minEditIntervalMs: 3000 },
    verify: async () => notImplemented(),
    connect: async () => notImplemented(),
    send: async () => notImplemented(),
    update: async () => notImplemented(),
  };
}
