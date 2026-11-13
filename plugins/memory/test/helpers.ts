import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { createDb, startTestKernel, startTestRedis, testKernelConfig } from "@capybara-hq/testing";

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const MEMORY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** The plugin's schema (`plugin_<name>`). */
export const SCHEMA = "plugin_memory";

/**
 * Runs the plugin's migrations the way a deployment does: a real kernel loads the extension
 * (auto-approved in tests), which migrates `plugin_memory`; then the kernel stops. The database
 * at `pgUrl` keeps the kernel's and the plugin's schemas.
 */
export async function migrate(pgUrl: string): Promise<void> {
  const rd = await startTestRedis();
  try {
    const k = await startTestKernel(
      testKernelConfig({ pg: pgUrl, redis: rd.url }, { extensions: [MEMORY], roles: ["api"] }),
      { resolveFrom: PLUGIN_DIR },
    );
    await k.close();
  } finally {
    await rd.stop();
  }
}

/** A pool on `pgUrl` whose queries run in `plugin_memory` (what the kernel hands the extension as `ctx.db`). */
export function pluginDb(pgUrl: string): {
  db: ExtensionContext["db"];
  destroy: () => Promise<void>;
} {
  const raw = createDb(pgUrl, 4) as unknown as ExtensionContext["db"];
  return { db: raw.withSchema(SCHEMA), destroy: () => raw.destroy() };
}
