// Builds what the plugin ships under ui/ (the plugin-root directory the packer copies as is;
// dist/ is replaced by the extension bundle):
// - ui/service/: the daemon's service files (daemon/build.ts), sent to the device on start;
// - ui/panel.js: the panel's browser bundle (ui-src/panel/entry.ts, iife), served at /ui/panel.js.
// Run by `pnpm build:ui` (the repository runs it before pack, marketplace and release).

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildDaemon } from "./daemon/build.ts";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildUi(outDir = join(here, "ui")): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await buildDaemon(join(outDir, "service"));
  await build({
    entryPoints: [join(here, "ui-src", "panel", "entry.ts")],
    outfile: join(outDir, "panel.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["chrome120", "safari17"],
    legalComments: "none",
    charset: "utf8",
    logLevel: "silent",
  });
  process.stderr.write(`panel built into ${join(outDir, "panel.js")}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildUi(process.argv[2]);
}
