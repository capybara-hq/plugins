import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findUpstream, readRemotes } from "@capybara-hq/dev/remotes";

/**
 * 开工用的 git worktree 小工具（`pnpm wt:new | wt:rm | wt:ls`）。
 *
 * 约定（见 AGENTS.md「分支与 worktree」）：Claude 会话留在主 checkout，主 checkout 的 HEAD 只停
 * `main`；任务分支一律建到 `.claude/worktrees/<目录>` 里，合并后 `pnpm wt:rm` 清理。
 * 在主 checkout 里切任务分支会被 `.claude/hooks/branch-safety.sh` 拦下。
 *
 * 为什么不直接 `git worktree add`：pnpm 按目录装依赖，新 worktree 是空的，要在里面独立
 * `pnpm install`（走全局 store，不重新下载）。node_modules 不软链：Next / Vite 按真实路径解析，
 * 软链过去会把项目根认到主 checkout。本脚本把建 worktree 与装依赖一起做掉，
 * 并只在 `.claude/worktrees/`（已 gitignore）下建目录。
 *
 * 用法：
 *   pnpm wt:new <branch> [--from origin/main] [--no-install]  # 远端已有该分支则 checkout，否则从 --from 切
 *   pnpm wt:rm  <branch|目录名> [--force]                       # 删 worktree（分支不删）
 *   pnpm wt:ls
 *
 * **`wt:new` 的分支名必须是第一个参数**，选项写在它后面，原因见 `parseNewArgs`。
 */

export const WORKTREE_DIR = ".claude/worktrees";

/** This repository's name under github.com/capybara-hq, used to find the upstream remote. */
const REPO = "plugins";

export interface RunOptions {
  /** 在哪个目录下执行（主 checkout 或任一 worktree 都行），默认 process.cwd() */
  cwd?: string;
  /** 输出（测试里收集），默认 console.log */
  log?: (line: string) => void;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** 主 checkout 的根目录（`git worktree list` 第一条永远是主 worktree），在任一 worktree 里调用结果相同 */
export function mainRoot(cwd: string): string {
  const first = git(["worktree", "list", "--porcelain"], cwd).split("\n")[0] ?? "";
  const root = first.replace(/^worktree /, "");
  if (!root) throw new Error("无法定位主 worktree（git worktree list 为空）");
  return root;
}

/** 分支名 -> 目录名：`/` 等非常规字符换 `-`（`feat/m7-release` -> `feat-m7-release`） */
export function dirNameForBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]/g, "-");
}

function ensureIgnored(root: string): void {
  // 模式是 `.claude/worktrees/`（带尾斜杠 = 只匹配目录）：目录尚不存在时 git 判不出它是目录，
  // 直接查目录名会误报「未忽略」，所以拿它下面的一个虚构子路径去问。
  const r = spawnSync("git", ["check-ignore", "-q", `${WORKTREE_DIR}/probe`], { cwd: root });
  if (r.status !== 0) {
    throw new Error(
      `${WORKTREE_DIR}/ 没有被 .gitignore 忽略——先加进去再建，否则整个 checkout 会被当成未跟踪文件`,
    );
  }
}

const NEW_USAGE = [
  "用法：pnpm wt:new <branch> [--from <起点>] [--no-install]",
  "      ↑ 分支名必须是第一个参数，选项一律写在它后面。",
  "  例：pnpm wt:new feat/m7-release",
  "      pnpm wt:new fix/foo --from origin/feat/m7-release",
].join("\n");

/** `git remote` 的名字（挡「把起点写到分支位上」）；取不到就按只有 origin 处理 */
function remoteNames(root: string): string[] {
  try {
    const out = git(["remote"], root)
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    return out.length > 0 ? out : ["origin"];
  } catch {
    return ["origin"];
  }
}

/**
 * `wt:new` 的参数解析——快速失败，绝不猜。
 *
 * 顺序写反（`--from origin/main feat/x`）时，「取第一个非选项参数当分支名」的写法会把
 * `origin/main` 当成分支名，在本地建出一条字面名叫 `origin/main` 的分支，此后全仓库的
 * `origin/main` 都成了歧义引用（`refname 'origin/main' is ambiguous`），清理要
 * `git update-ref -d refs/heads/origin/main`。后果与手滑完全不成比例，所以堵在脚本里：
 *
 * 1. 第一个参数不是分支名（顺序写反、或压根没给）；
 * 2. 分支名以某个 remote 名开头（`origin/…`）——几乎必然是把起点写到了分支位上；
 * 3. 位置参数多于一个——静默忽略多余的正好会掩盖顺序写反；
 * 4. `--from` 缺取值、或取值看起来是个选项；
 * 5. 不认识的选项——`--form origin/feat/x` 这种拼错会让 `--from` 静默退回 origin/main。
 *
 * 不校验 `--from` 必须是远端引用：本地分支（另一个 worktree 里的 feat 分支）是合法起点，
 * 写错的引用会由 `git worktree add` 自己报错。
 */
export function parseNewArgs(
  argv: string[],
  remotes: string[],
  defaultFrom: string,
): { branch: string; from: string; install: boolean } {
  const first = argv[0];
  if (first === undefined) throw new Error(`没给分支名。\n${NEW_USAGE}`);
  if (first.startsWith("-")) {
    throw new Error(
      `第一个参数必须是分支名，读到的却是选项 \`${first}\`。\n` +
        "顺序写反时分支名会取到起点（会建出一条字面名叫 `origin/main` 的分支，" +
        "让全仓库的 origin/main 变成歧义引用），所以这里直接拒绝。\n" +
        NEW_USAGE,
    );
  }

  const positionals: string[] = [];
  let from = defaultFrom;
  let install = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--from") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new Error(
          `--from 后面缺少取值（读到${v === undefined ? "参数结尾" : ` \`${v}\`，那是个选项`}）。\n${NEW_USAGE}`,
        );
      }
      from = v;
      i++;
      continue;
    }
    if (a.startsWith("--from=")) {
      const v = a.slice("--from=".length);
      if (!v) throw new Error(`--from= 后面缺少取值。\n${NEW_USAGE}`);
      from = v;
      continue;
    }
    if (a === "--no-install") {
      install = false;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(
        `不认识的选项 \`${a}\`。\n` +
          "（拼错的选项不会被忽略：`--form origin/feat/x` 会让 --from 静默退回 origin/main。）\n" +
          NEW_USAGE,
      );
    }
    positionals.push(a);
  }

  if (positionals.length > 1) {
    throw new Error(
      `只接受一个分支名，但读到 ${positionals.length} 个：${positionals.map((x) => `\`${x}\``).join(" ")}。\n${NEW_USAGE}`,
    );
  }

  const branch = positionals[0] as string;
  const hitRemote = remotes.find((r) => branch === r || branch.startsWith(`${r}/`));
  if (hitRemote) {
    throw new Error(
      `分支名 \`${branch}\` 以 remote 名 \`${hitRemote}\` 开头——这几乎一定是把起点写到了分支位上。\n` +
        `真按这个名字建下去，本地会多出一条字面名叫 \`${branch}\` 的分支，此后引用它都会变成歧义引用。\n` +
        NEW_USAGE,
    );
  }
  return { branch, from, install };
}

/** `wt:rm` 的参数：一个 worktree（分支名或目录名）+ 可选 `--force`；不认识的选项直接拒绝 */
export function parseRmArgs(argv: string[]): { name: string; force: boolean } {
  const usage = "用法：pnpm wt:rm <branch|目录名> [--force]";
  const positionals: string[] = [];
  let force = false;
  for (const a of argv) {
    if (a === "--force") force = true;
    else if (a.startsWith("-")) throw new Error(`不认识的选项 \`${a}\`。\n${usage}`);
    else positionals.push(a);
  }
  if (positionals.length !== 1) throw new Error(usage);
  return { name: positionals[0] as string, force };
}

function refExists(root: string, ref: string): boolean {
  return spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: root }).status === 0;
}

export function cmdNew(argv: string[], opts: RunOptions = {}): string {
  const log = opts.log ?? console.log;
  const root = mainRoot(opts.cwd ?? process.cwd());
  const upstream = findUpstream(readRemotes(root), REPO);
  const upstreamRemote = upstream?.remote ?? "origin";
  const { branch, from, install } = parseNewArgs(argv, remoteNames(root), `${upstreamRemote}/main`);
  if (spawnSync("git", ["check-ref-format", "--branch", branch], { cwd: root }).status !== 0) {
    throw new Error(`\`${branch}\` 不是合法的分支名`);
  }
  ensureIgnored(root);
  const target = resolve(root, WORKTREE_DIR, dirNameForBranch(branch));
  if (existsSync(target)) throw new Error(`目录已存在：${target}（要重建先 pnpm wt:rm）`);

  // Fetch the upstream (the default start point) and, in a fork clone, origin too (existing branches).
  for (const remote of new Set([upstreamRemote, "origin"])) {
    execFileSync("git", ["fetch", remote], { cwd: root, stdio: "inherit" });
  }
  let mode: string;
  if (refExists(root, `refs/heads/${branch}`)) {
    execFileSync("git", ["worktree", "add", target, branch], { cwd: root, stdio: "inherit" });
    mode = "checkout 本地已有分支";
  } else if (refExists(root, `refs/remotes/origin/${branch}`)) {
    execFileSync("git", ["worktree", "add", "--track", "-b", branch, target, `origin/${branch}`], {
      cwd: root,
      stdio: "inherit",
    });
    mode = "checkout 远端分支";
  } else {
    // --no-track：新分支不跟踪 origin/main，否则裸 `git push` 有推到 main 的风险
    execFileSync("git", ["worktree", "add", "--no-track", "-b", branch, target, from], {
      cwd: root,
      stdio: "inherit",
    });
    mode = upstream?.fork
      ? `Created from ${from}, not pushed yet; origin is your fork, push with git push -u origin ${branch}`
      : `从 ${from} 新建分支（尚未 push；首次推送用 git push -u origin ${branch}）`;
  }

  if (install) {
    execFileSync("pnpm", ["install", "--prefer-offline"], { cwd: target, stdio: "inherit" });
  }
  log(
    JSON.stringify(
      { path: target, branch, mode, installed: install, next: `cd ${target}` },
      null,
      2,
    ),
  );
  return target;
}

export function cmdRm(argv: string[], opts: RunOptions = {}): string {
  const log = opts.log ?? console.log;
  const { name, force } = parseRmArgs(argv);
  const root = mainRoot(opts.cwd ?? process.cwd());
  const byDir = resolve(root, WORKTREE_DIR, name);
  const candidate = existsSync(byDir) ? byDir : resolve(root, WORKTREE_DIR, dirNameForBranch(name));
  if (!existsSync(candidate)) throw new Error(`找不到 worktree：${candidate}`);
  const args = ["worktree", "remove", candidate];
  if (force) args.push("--force");
  execFileSync("git", args, { cwd: root, stdio: "inherit" });
  execFileSync("git", ["worktree", "prune"], { cwd: root, stdio: "inherit" });
  log(`已删除 ${candidate}（分支未删；不再需要时 git branch -d <branch>）`);
  return candidate;
}

export function cmdLs(opts: RunOptions = {}): void {
  execFileSync("git", ["worktree", "list"], {
    cwd: mainRoot(opts.cwd ?? process.cwd()),
    stdio: "inherit",
  });
}

/** CLI 入口：返回进程退出码 */
export function main(argv: string[]): number {
  const [sub, ...rest] = argv;
  try {
    if (sub === "new") cmdNew(rest);
    else if (sub === "rm") cmdRm(rest);
    else if (sub === "ls" || sub === undefined) cmdLs();
    else throw new Error(`未知子命令 ${sub}；可用：new / rm / ls`);
    return 0;
  } catch (err) {
    console.error(`[worktree] ${(err as Error).message}`);
    return 1;
  }
}
