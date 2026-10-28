import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FULL_SHARDS,
  loadWorkspace,
  planAll,
  planFromFiles,
  toOutputs,
  type Workspace,
  type WorkspacePackage,
} from "../src/affected.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const pkg = (
  dir: string,
  deps: string[] = [],
  opts: { hasTests?: boolean; plugin?: boolean } = {},
): WorkspacePackage => {
  const short = dir.split("/")[1] ?? dir;
  return {
    dir,
    name: `@x/${short}`,
    deps,
    ...(opts.plugin === false || !dir.startsWith("plugins/") ? {} : { plugin: short }),
    hasTests: opts.hasTests ?? true,
  };
};

/** A small workspace shaped like the real one. */
const ws: Workspace = {
  packages: [
    pkg("plugins/slack", ["@capybara-hq/plugin-sdk", "@capybara-hq/testing"]),
    pkg("plugins/lark", ["@capybara-hq/plugin-sdk"]),
    // Depends on lark by plugin.json, on slack by a devDependency.
    pkg("plugins/bundle", ["plugin:lark", "@x/slack"]),
    // Depends on bundle by plugin.json: transitively on lark and slack.
    pkg("plugins/outer", ["plugin:bundle"]),
    pkg("plugins/openai", []),
    pkg("plugins/openai-compatible", []),
    pkg("plugins/no-tests", [], { hasTests: false }),
    pkg("tools/worktree"),
    pkg("tools/checks"),
  ],
};

const plan = (...files: string[]) => planFromFiles(files, ws);

describe("planFromFiles: run everything", () => {
  it.each([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "vitest.config.ts",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.test.json",
    "biome.json",
    ".github/workflows/ci.yml",
    ".github/CODEOWNERS",
    "tools/ci/src/affected.ts",
    "tools/dev/src/verify.ts",
    "tools/checks/README.md",
    // Outside every workspace package and not a doc: unknown, so everything.
    "commitlint.config.ts",
    "LICENSE",
    ".changeset/nested/x.json",
  ])("%s", (f) => {
    const p = plan("plugins/slack/src/index.ts", f);
    expect(p).toMatchObject({ all: true, test: true, testDirs: [], shards: FULL_SHARDS });
    expect(p.reason).toContain(f);
  });

  it("only root files of those names count: a plugin's own package.json / tsconfig does not", () => {
    expect(plan("plugins/lark/package.json", "plugins/lark/tsconfig.json").all).toBe(false);
  });

  it("planAll (push to main, diff unavailable)", () => {
    expect(planAll("push to main")).toEqual({
      reason: "push to main",
      all: true,
      testDirs: [],
      test: true,
      shards: FULL_SHARDS,
    });
  });
});

describe("planFromFiles: no tests", () => {
  it.each([
    ["docs", ["docs/x.md", "README.md", "plugins/x.md", ".gitignore"]],
    ["the Claude settings outside the hooks", [".claude/notes.txt"]],
    ["the marketplace and changesets", [".capybara-plugin/marketplace.json", ".changeset/a.md"]],
    ["the changesets config", [".changeset/config.json", ".changeset/pre.json"]],
    ["an empty diff", []],
  ])("%s", (_, files) => {
    const p = plan(...files);
    expect(p).toMatchObject({ all: false, test: false, testDirs: [] });
  });
});

describe("planFromFiles: by diff", () => {
  it("a plugin nothing depends on: its own tests only, one shard", () => {
    expect(plan("plugins/openai/src/index.ts")).toMatchObject({
      all: false,
      test: true,
      testDirs: ["plugins/openai"],
      shards: 1,
    });
  });

  it("a plugin's dependents, by plugin.json and by package.json, transitively", () => {
    expect(plan("plugins/lark/src/index.ts").testDirs).toEqual([
      "plugins/bundle",
      "plugins/lark",
      "plugins/outer",
    ]);
    expect(plan("plugins/slack/test/x.test.ts").testDirs).toEqual([
      "plugins/bundle",
      "plugins/outer",
      "plugins/slack",
    ]);
  });

  it("files inside a plugin count for it, its docs and skills included", () => {
    expect(plan("plugins/openai/README.md").testDirs).toEqual(["plugins/openai"]);
    expect(plan("plugins/openai/skills/a/SKILL.md").testDirs).toEqual(["plugins/openai"]);
  });

  it("packages without a test dir are not passed to vitest", () => {
    expect(plan("plugins/no-tests/src/x.ts")).toMatchObject({ test: false, testDirs: [] });
  });

  it("extra inputs outside packages map to the tests that read them", () => {
    expect(plan(".claude/hooks/branch-safety.sh").testDirs).toEqual(["tools/worktree"]);
    expect(plan(".claude/settings.json").testDirs).toEqual(["tools/worktree"]);
    expect(plan(".agents/skills/writing-plugins/SKILL.md").testDirs).toEqual(["tools/checks"]);
  });

  it("directories end with a slash so plugins/openai doesn't match openai-compatible", () => {
    const out = toOutputs(plan("plugins/openai/src/index.ts"));
    expect(out).toEqual({
      reason: "changed packages: plugins/openai",
      test: "true",
      "test-dirs": "plugins/openai/",
      "test-shards": "[1]",
      "test-shard-total": "1",
    });
  });

  it("full run: no filter", () => {
    expect(toOutputs(planAll("push to main"))).toMatchObject({
      "test-dirs": "",
      "test-shards": JSON.stringify(Array.from({ length: FULL_SHARDS }, (_, i) => i + 1)),
    });
  });
});

describe("the real workspace", () => {
  const real = loadWorkspace(repoRoot);

  it("reads every plugin and tool with its plugin name", () => {
    const dirs = real.packages.map((p) => p.dir);
    expect(dirs).toEqual(
      expect.arrayContaining(["plugins/slack", "plugins/sandbox-docker", "tools/ci", "tools/dev"]),
    );
    expect(dirs).not.toContain("plugins/model-fake");
    const slack = real.packages.find((p) => p.dir === "plugins/slack");
    expect(slack?.plugin).toBe("slack");
    expect(slack?.deps).toContain("@capybara-hq/testing");
  });

  it("a slack change runs slack's tests only", () => {
    expect(planFromFiles(["plugins/slack/src/index.ts"], real).testDirs).toEqual(["plugins/slack"]);
  });

  it("the CLI prints the outputs and runs everything when asked", () => {
    const run = (args: string[], input: string) =>
      execFileSync(process.execPath, [`${repoRoot}/tools/ci/src/cli.ts`, ...args], {
        input,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: "" },
      });
    expect(run([], "plugins/todo/src/index.ts\n")).toContain("test-dirs=plugins/todo/");
    expect(run(["--all", "push to main"], "")).toContain("reason=push to main");
  });
});
