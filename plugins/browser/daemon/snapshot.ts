// The page snapshot (spec §9): Playwright's accessibility snapshot in its AI mode, whose element
// refs (`e12`, `f1e3` inside frames) the ref actions resolve with page.getByRef, capped in size.

import type { Page } from "playwright-core";
import { SNAPSHOT_MAX_CHARS } from "./protocol.js";

const isNode = (line: string) => line.trimStart().startsWith("- ");

/**
 * Cuts `text` at a line boundary so the result, marker included, is at most `max` characters;
 * the marker `[truncated: N more nodes]` counts the tree nodes left out.
 */
export function capSnapshot(text: string, max = SNAPSHOT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const marker = (n: number) => `[truncated: ${n} more nodes]`;
  // the marker of the largest possible count bounds every marker's length
  const room = max - marker(lines.length).length - 1;
  let used = 0;
  let kept = 0;
  while (kept < lines.length) {
    const len = (lines[kept] ?? "").length + 1;
    if (used + len > room) break;
    used += len;
    kept++;
  }
  const rest = lines.slice(kept).filter(isNode).length;
  return `${lines.slice(0, kept).join("\n")}\n${marker(rest)}`;
}

/** The capped snapshot of `page`; refs resolve against it until the next snapshot. */
export async function takeSnapshot(page: Page): Promise<string> {
  return capSnapshot(await page.ariaSnapshot({ mode: "ai" }));
}
