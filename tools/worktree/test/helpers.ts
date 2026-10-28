import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

export interface Sandbox {
  base: string;
  /** 主 checkout（HEAD 在 main） */
  main: string;
  origin: string;
  cleanup: () => void;
}

/**
 * 临时仓库：裸仓库 origin（main + 远端分支 feat/remote）与它的 clone（主 checkout）。
 * `ignoreWorktrees` 为 false 时 .gitignore 不含 .claude/worktrees/。
 */
export function makeRepo(opts: { ignoreWorktrees?: boolean } = {}): Sandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cap-wt-")));
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const main = join(base, "main");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(
    join(seed, ".gitignore"),
    opts.ignoreWorktrees === false ? "node_modules\n" : "node_modules\n.claude/worktrees/\n",
  );
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(seed, "switch", "-q", "-c", "feat/remote");
  writeFileSync(join(seed, "remote.txt"), "remote\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "remote work");
  git(seed, "push", "-q", "origin", "feat/remote");
  git(base, "clone", "-q", origin, main);
  return { base, main, origin, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
