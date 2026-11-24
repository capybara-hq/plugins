// The daemon's service files (browser use spec §5): every file under `ui/service/`, written there
// by build-ui.ts (daemon.mjs and vendor/playwright-core/). `ui/` is the plugin-root directory the
// packer ships as is (`dist/` is replaced by the extension bundle), and the same relative path
// works from `src/` (tests, source loading) and from the packed `dist/`.
import { readdir, readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceServiceSpec } from "@capybara-hq/plugin-sdk";
import { SERVICE } from "./browser.js";

/** The daemon's entry, one of the files. */
export const SERVICE_ENTRY = "daemon.mjs";

/** Reads every file under `dir`, keyed by its relative POSIX path. */
export async function readServiceFiles(dir: URL): Promise<Record<string, Uint8Array>> {
  const root = fileURLToPath(dir);
  const files: Record<string, Uint8Array> = {};
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = `${e.parentPath}${sep}${e.name}`;
    files[relative(root, abs).split(sep).join("/")] = new Uint8Array(await readFile(abs));
  }
  return files;
}

/**
 * The service spec loader of one extension instance: the files are read on first use and kept
 * for the instance's life (immutable build output, not shared state). A missing build is an
 * error the next call retries.
 */
export function serviceSpecLoader(
  dir: URL = new URL("../ui/service/", import.meta.url),
): () => Promise<DeviceServiceSpec> {
  let loading: Promise<DeviceServiceSpec> | undefined;
  return () => {
    loading ??= (async () => {
      const files = await readServiceFiles(dir);
      if (!Object.hasOwn(files, SERVICE_ENTRY))
        throw new Error(
          `browser: ${SERVICE_ENTRY} is missing under ${fileURLToPath(dir)} (run build:ui)`,
        );
      return { name: SERVICE, runtime: "node", entry: SERVICE_ENTRY, args: [], files };
    })();
    loading.catch(() => {
      loading = undefined;
    });
    return loading;
  };
}

/** The panel script loader of one extension instance (`ui/panel.js`); undefined when not built. */
export function panelScriptLoader(
  file: URL = new URL("../ui/panel.js", import.meta.url),
): () => Promise<string | undefined> {
  let cached: Promise<string | undefined> | undefined;
  return () => {
    cached ??= readFile(file, "utf8").catch(() => {
      cached = undefined;
      return undefined;
    });
    return cached;
  };
}
