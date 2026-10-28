import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cmdNew,
  cmdRm,
  dirNameForBranch,
  parseNewArgs,
  parseRmArgs,
  WORKTREE_DIR,
} from "../src/worktree.js";
import { git, makeRepo, type Sandbox } from "./helpers.js";

describe("parseNewArgs", () => {
  const remotes = ["origin"];
  const defaultFrom = "origin/main";

  it("默认从 origin/main 切、装依赖", () => {
    expect(parseNewArgs(["feat/x"], remotes, defaultFrom)).toEqual({
      branch: "feat/x",
      from: "origin/main",
      install: true,
    });
  });

  it("认 --from / --from= / --no-install", () => {
    expect(
      parseNewArgs(["fix/y", "--from", "origin/feat/x", "--no-install"], remotes, defaultFrom),
    ).toEqual({
      branch: "fix/y",
      from: "origin/feat/x",
      install: false,
    });
    expect(parseNewArgs(["fix/y", "--from=feat/x"], remotes, defaultFrom).from).toBe("feat/x");
  });

  it("分支名必须是第一个参数（顺序写反直接拒绝）", () => {
    expect(() => parseNewArgs(["--from", "origin/main", "feat/x"], remotes, defaultFrom)).toThrow(
      /第一个参数必须是分支名/,
    );
    expect(() => parseNewArgs([], remotes, defaultFrom)).toThrow(/没给分支名/);
  });

  it("拒绝以 remote 名开头的分支名", () => {
    expect(() => parseNewArgs(["origin/main"], remotes, defaultFrom)).toThrow(/remote 名/);
    expect(() => parseNewArgs(["origin"], remotes, defaultFrom)).toThrow(/remote 名/);
    expect(parseNewArgs(["originals/x"], remotes, defaultFrom).branch).toBe("originals/x");
  });

  it("拒绝多个位置参数、缺取值的 --from、不认识的选项", () => {
    expect(() => parseNewArgs(["feat/x", "feat/y"], remotes, defaultFrom)).toThrow(
      /只接受一个分支名/,
    );
    expect(() => parseNewArgs(["feat/x", "--from"], remotes, defaultFrom)).toThrow(/缺少取值/);
    expect(() => parseNewArgs(["feat/x", "--from", "--no-install"], remotes, defaultFrom)).toThrow(
      /缺少取值/,
    );
    expect(() => parseNewArgs(["feat/x", "--from="], remotes, defaultFrom)).toThrow(/缺少取值/);
    expect(() => parseNewArgs(["feat/x", "--form", "origin/feat/y"], remotes, defaultFrom)).toThrow(
      /不认识的选项/,
    );
  });
});

describe("parseRmArgs / dirNameForBranch", () => {
  it("rm 只认一个名字与 --force", () => {
    expect(parseRmArgs(["feat/x"])).toEqual({ name: "feat/x", force: false });
    expect(parseRmArgs(["feat-x", "--force"])).toEqual({ name: "feat-x", force: true });
    expect(() => parseRmArgs([])).toThrow(/用法/);
    expect(() => parseRmArgs(["a", "b"])).toThrow(/用法/);
    expect(() => parseRmArgs(["a", "-f"])).toThrow(/不认识的选项/);
  });

  it("目录名把 / 换成 -", () => {
    expect(dirNameForBranch("feat/m7-release")).toBe("feat-m7-release");
    expect(dirNameForBranch("chore/a/b")).toBe("chore-a-b");
  });
});

describe("wt:new / wt:rm（临时仓库）", () => {
  let repo: Sandbox | undefined;
  const log = () => {};
  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
  });

  it("远端没有该分支：从 --from 新建，不跟踪上游", { timeout: 30_000 }, () => {
    repo = makeRepo();
    const target = cmdNew(["feat/new", "--no-install"], { cwd: repo.main, log });
    expect(target).toBe(join(repo.main, WORKTREE_DIR, "feat-new"));
    expect(git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/new");
    expect(git(target, "rev-parse", "HEAD")).toBe(git(repo.main, "rev-parse", "origin/main"));
    expect(() => git(target, "rev-parse", "--abbrev-ref", "feat/new@{upstream}")).toThrow();
    // 主 checkout 的 HEAD 不动
    expect(git(repo.main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("in a fork clone, new branches start from upstream/main", { timeout: 30_000 }, () => {
    repo = makeRepo();
    const url = "https://github.com/capybara-hq/plugins.git";
    const upstream = join(repo.base, "upstream.git");
    const work = join(repo.base, "work");
    // upstream gets one commit that the fork's main does not have
    git(repo.base, "clone", "-q", "--bare", repo.origin, upstream);
    git(repo.base, "clone", "-q", upstream, work);
    writeFileSync(join(work, "ahead.txt"), "ahead\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "upstream ahead");
    git(work, "push", "-q", "origin", "main");
    git(repo.main, "config", `url.${upstream}.insteadOf`, url);
    git(repo.main, "remote", "add", "upstream", url);
    const target = cmdNew(["feat/fork", "--no-install"], { cwd: repo.main, log });
    expect(git(target, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "main"));
    expect(git(repo.main, "rev-parse", "origin/main")).not.toBe(git(upstream, "rev-parse", "main"));
  });

  it("远端已有该分支：checkout 并跟踪远端", { timeout: 30_000 }, () => {
    repo = makeRepo();
    const target = cmdNew(["feat/remote", "--no-install"], { cwd: repo.main, log });
    expect(existsSync(join(target, "remote.txt"))).toBe(true);
    expect(git(target, "rev-parse", "--abbrev-ref", "feat/remote@{upstream}")).toBe(
      "origin/feat/remote",
    );
  });

  it("在 worktree 里执行也建到主 checkout 的 .claude/worktrees 下", { timeout: 30_000 }, () => {
    repo = makeRepo();
    const first = cmdNew(["feat/a", "--no-install"], { cwd: repo.main, log });
    const second = cmdNew(["fix/b", "--no-install", "--from", "feat/a"], { cwd: first, log });
    expect(second).toBe(join(repo.main, WORKTREE_DIR, "fix-b"));
  });

  it(".claude/worktrees/ 没被忽略时拒绝", { timeout: 30_000 }, () => {
    repo = makeRepo({ ignoreWorktrees: false });
    const cwd = repo.main;
    expect(() => cmdNew(["feat/x", "--no-install"], { cwd, log })).toThrow(/gitignore/);
    expect(existsSync(join(repo.main, WORKTREE_DIR))).toBe(false);
  });

  it("目录已存在时拒绝；wt:rm 按分支名或目录名删除，分支保留", { timeout: 30_000 }, () => {
    repo = makeRepo();
    const cwd = repo.main;
    const target = cmdNew(["feat/x", "--no-install"], { cwd, log });
    expect(() => cmdNew(["feat/x", "--no-install"], { cwd, log })).toThrow(/目录已存在/);
    expect(cmdRm(["feat/x"], { cwd, log })).toBe(target);
    expect(existsSync(target)).toBe(false);
    expect(git(repo.main, "branch", "--list", "feat/x")).toContain("feat/x");

    const again = cmdNew(["feat/x", "--no-install"], { cwd, log });
    expect(cmdRm(["feat-x"], { cwd, log })).toBe(again);
    expect(() => cmdRm(["feat/none"], { cwd, log })).toThrow(/找不到 worktree/);
  });
});
