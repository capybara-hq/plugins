import { spawnSync } from "node:child_process";

export type Remote = { name: string; url: string };

/** Arguments for listing the configured remote URLs (raw, without `insteadOf` rewrites). */
export const REMOTE_URL_CONFIG_ARGS = ["config", "--get-regexp", "^remote\\..+\\.url$"];

/**
 * Parses `git config --get-regexp '^remote\..+\.url$'` output (`remote.<name>.url <url>` lines)
 * into name/url pairs, keeping the first url of each remote.
 */
export function parseRemoteConfig(output: string): Remote[] {
  const seen = new Map<string, Remote>();
  for (const line of output.split("\n")) {
    const m = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
    if (m?.[1] === undefined || m[2] === undefined) continue;
    if (!seen.has(m[1])) seen.set(m[1], { name: m[1], url: m[2] });
  }
  return [...seen.values()];
}

/**
 * Reads the configured remote URLs as written in the git config. `git remote -v` is not used
 * because it applies `url.<base>.insteadOf` rewrites, which would hide the canonical URL.
 */
export function readRemotes(cwd: string): Remote[] {
  const r = spawnSync("git", REMOTE_URL_CONFIG_ARGS, { cwd, encoding: "utf8" });
  return r.status === 0 ? parseRemoteConfig(r.stdout) : [];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the remote pointing at github.com/capybara-hq/<repo> (https, git@github.com: or
 * ssh://git@github.com/). `fork` is true when
 * that remote is not `origin`, i.e. the person works in a fork clone.
 */
export function findUpstream(
  remotes: Remote[],
  repo: string,
): { remote: string; fork: boolean } | null {
  const re = new RegExp(
    `^(?:https://(?:[^@/]+@)?github\\.com/|git@github\\.com:|ssh://git@github\\.com/)capybara-hq/${escapeRegExp(repo)}(?:\\.git)?/?$`,
    "i",
  );
  const matches = remotes.filter((r) => re.test(r.url));
  const hit = matches.find((r) => r.name === "origin") ?? matches[0];
  return hit === undefined ? null : { remote: hit.name, fork: hit.name !== "origin" };
}
