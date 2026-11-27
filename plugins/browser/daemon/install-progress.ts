// What a request is told while the daemon's first start installs the browser (capybara-hq/plugins#311):
// the install takes minutes on a slow network (a zip of about 200 MB, then unpacking), so a
// request answers at once that it is in progress, with how far the download got, instead of
// waiting for it past the plugin's request timeout.
//
// Playwright downloads into `<TMPDIR>/playwright-download-*/<zip>` (the service's own temporary
// directory) and unpacks from there, removing the directory once the browser is in place; its
// progress lines on stdout ("… 40% of 180.3 MiB") give the zip's size.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The bytes of the zips being downloaded in `tmpDir` (undefined when no download is there). */
export function downloadedBytes(tmpDir: string): number | undefined {
  let names: string[];
  try {
    names = readdirSync(tmpDir);
  } catch {
    return undefined;
  }
  let total: number | undefined;
  for (const name of names) {
    if (!name.startsWith("playwright-download-")) continue;
    const dir = join(tmpDir, name);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        const st = lstatSync(join(dir, file));
        if (st.isFile()) total = (total ?? 0) + st.size;
      }
    } catch {
      // removed meanwhile: the download moved on
    }
  }
  return total;
}

/** A download progress line's total ("|■■■…| 40% of 180.3 MiB"), in bytes. */
export function progressLineTotal(line: string): number | undefined {
  const m = /\bof (\d+(?:\.\d+)?) MiB\b/.exec(line);
  return m === null ? undefined : Math.round(Number(m[1]) * 1024 * 1024);
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** The installing reply's text, with what is known of the download. */
export function installingMessage(p: { downloaded?: number; total?: number }): string {
  let state: string;
  if (p.downloaded === undefined)
    state = p.total === undefined ? "starting the download" : "downloaded, unpacking it";
  else if (p.total !== undefined && p.downloaded >= p.total)
    state = `${mb(p.total)} MB downloaded, unpacking it`;
  else
    state =
      p.total === undefined
        ? `${mb(p.downloaded)} MB downloaded`
        : `${mb(p.downloaded)} of ${mb(p.total)} MB downloaded`;
  return `The browser is being installed in the device (${state}); this happens once per browser version. Call the tool again in a moment.`;
}
