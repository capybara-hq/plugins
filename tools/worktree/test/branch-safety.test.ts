import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, makeRepo, type Sandbox } from "./helpers.js";

/** 仓库里提交的 hook 本体（.claude/settings.json 接的就是它） */
const HOOK = fileURLToPath(new URL("../../../.claude/hooks/branch-safety.sh", import.meta.url));

let repo: Sandbox;
/** 主 checkout 里的一个 worktree，HEAD 在 feat/wt */
let wt: string;

beforeAll(() => {
  repo = makeRepo();
  wt = join(repo.main, ".claude/worktrees/feat-wt");
  git(repo.main, "worktree", "add", "-q", "--no-track", "-b", "feat/wt", wt, "origin/main");
});
afterAll(() => repo.cleanup());

function decide(command: string, cwd: string): "deny" | "allow" {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  if (r.stdout.trim() === "") return "allow";
  const out = JSON.parse(r.stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  expect(out.hookSpecificOutput.permissionDecisionReason).not.toBe("");
  return out.hookSpecificOutput.permissionDecision === "deny" ? "deny" : "allow";
}

describe("branch-safety hook：推送 main", () => {
  it.each([
    "git push origin main",
    'git push origin "main"',
    "git push origin 'main'",
    "git push origin HEAD:main",
    "git push origin HEAD:refs/heads/main",
    "git push origin refs/heads/main",
    "git push -f origin feat/wt:main",
    "git push origin +main",
    "git push --force-with-lease origin main",
    "pnpm lint && git push origin main",
    "git status; git push origin main",
  ])("拒绝（在 worktree 里也拒绝）：%s", (command) => {
    expect(decide(command, wt)).toBe("deny");
    expect(decide(command, repo.main)).toBe("deny");
  });

  it.each(["git push", "git push origin", "git push origin HEAD", "git push -u origin HEAD"])(
    "当前分支是 main 时拒绝、在任务分支上放行：%s",
    (command) => {
      expect(decide(command, repo.main)).toBe("deny");
      expect(decide(command, wt)).toBe("allow");
      expect(decide(`cd ${wt} && ${command}`, repo.main)).toBe("allow");
      expect(decide(`git -C ${wt} ${command.slice(4)}`, repo.main)).toBe("allow");
      expect(decide(`cd ${repo.main} && ${command}`, wt)).toBe("deny");
    },
  );

  it.each([
    "git push -u origin feat/wt",
    "git push origin feat/maintenance",
    "git push origin feat/main-page",
    'git commit -m "do not git push origin main"',
    "git log origin/main..HEAD",
    "git fetch origin main",
  ])("放行：%s", (command) => {
    expect(decide(command, wt)).toBe("allow");
  });
});

describe("branch-safety hook：主 checkout 切任务分支", () => {
  it.each([
    "git checkout feat/x",
    "git switch fix/y",
    "git switch -c docs/z",
    "git checkout -b chore/a",
    "git checkout --no-track -b test/b origin/main",
    "git switch -crefactor/c",
    "git switch -C feat/x origin/main",
    'git checkout "feat/x"',
    "git fetch && git checkout feat/x",
  ])("在主 checkout 里拒绝、在 worktree 里放行：%s", (command) => {
    expect(decide(command, repo.main)).toBe("deny");
    expect(decide(command, wt)).toBe("allow");
  });

  it("按 cd 与 git -C 判断目标仓库", () => {
    expect(decide(`cd ${wt} && git switch -c feat/y`, repo.main)).toBe("allow");
    expect(decide("cd .claude/worktrees/feat-wt && git switch feat/y", repo.main)).toBe("allow");
    expect(decide(`git -C ${wt} checkout fix/y`, repo.main)).toBe("allow");
    expect(decide(`git -C ${repo.main} switch feat/y`, wt)).toBe("deny");
    expect(decide(`cd ${repo.main} && git checkout feat/y`, wt)).toBe("deny");
  });

  it.each([
    "git status",
    "ls -la",
    "pnpm test",
    "git checkout main",
    "git switch main",
    "git checkout -- feat/file.ts",
    "git switch -c spike/foo",
    "git branch feat/x",
    "git worktree add .claude/worktrees/feat-x -b feat/x",
    "git restore feat/file.ts",
  ])("在主 checkout 里放行：%s", (command) => {
    expect(decide(command, repo.main)).toBe("allow");
  });

  it("本机开关 capybara.allowMainCheckoutTaskBranch 只放行切分支、不放行推 main", () => {
    git(repo.main, "config", "capybara.allowMainCheckoutTaskBranch", "true");
    try {
      expect(decide("git checkout feat/x", repo.main)).toBe("allow");
      expect(decide("git push origin main", repo.main)).toBe("deny");
    } finally {
      git(repo.main, "config", "--unset", "capybara.allowMainCheckoutTaskBranch");
    }
  });
});
