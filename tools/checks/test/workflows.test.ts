import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The workflows' safety properties, like core's tools/release/test/workflow.test.ts. Breaking any
// of these could publish unreviewed versions, publish from a PR, hand publish rights to the job that
// runs `changeset version`, or let a job escape `ci-ok`.
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  needs?: unknown;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: unknown;
  jobs: Record<string, Job>;
}
const jobText = (j: Job) => JSON.stringify(j);
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

describe("release.yml", () => {
  const wf = parse(read(".github/workflows/release.yml")) as Workflow;

  it("runs on push to main and manual dispatch only, never on pull requests", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(wf.on.push).toEqual({ branches: ["main"] });
    expect(wf.permissions).toEqual({});
    expect(Object.keys(wf.jobs).sort()).toEqual(["publish", "version-pr"]);
  });

  describe("version-pr", () => {
    const job = wf.jobs["version-pr"] as Job;

    it("runs on push only in this repository and can write contents and PRs, nothing else", () => {
      expect(job.if).toContain("github.event_name == 'push'");
      expect(job.if).toContain("github.repository == 'capybara-hq/plugins'");
      expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    });

    it("runs changesets/action without a publish command and never touches npm", () => {
      const cs = job.steps.filter((s) => s.uses?.startsWith("changesets/action@"));
      expect(cs).toHaveLength(1);
      expect(cs[0]?.with?.publish).toBeUndefined();
      expect(cs[0]?.with?.version).toBe("pnpm version-packages");
      expect(jobText(job)).not.toMatch(
        /NPM_TOKEN|NODE_AUTH_TOKEN|id-token|pnpm release|npm publish/,
      );
    });

    it("versions, then syncs the plugin manifests, then appends the marketplace entries", () => {
      // Order matters: the packer requires plugin.json / the manifest equal to package.json, and
      // the marketplace entries carry the sha512 of those packs.
      expect(pkg.scripts["version-packages"]).toBe(
        "changeset version && capybara-plugin sync-versions && capybara-plugin marketplace --write",
      );
    });
  });

  describe("publish", () => {
    const job = wf.jobs.publish as Job;

    it("is independent of version-pr and only reads contents (plus id-token for provenance)", () => {
      expect(job.needs).toBeUndefined();
      expect(job.if).toBe("github.repository == 'capybara-hq/plugins'");
      expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    });

    it("checks out exactly github.sha without persisted credentials", () => {
      const co = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(co?.with).toMatchObject({
        ref: ["$", "{{ github.sha }}"].join(""),
        "persist-credentials": false,
      });
    });

    it("publishes with provenance, --auto on push, --dry-run on a dry dispatch", () => {
      const step = job.steps.find((s) => s.id === "publish" || s.name === "Publish to npm");
      expect(step?.run).toContain("--provenance");
      expect(step?.run).toMatch(/"\$EVENT" = "push"[\s\S]*--auto/);
      expect(step?.run).toMatch(/"\$DRY_RUN" = "true"[\s\S]*--dry-run/);
      expect(step?.run).toContain(`pnpm release "$\{args[@]}"`);
      // The release checks every pack against .capybara-plugin/marketplace.json by default.
      expect(pkg.scripts.release).toBe("capybara-plugin release");
    });

    it("refuses a real manual publish from any ref but main", () => {
      const guard = job.steps.find((s) => s.name === "Check the ref of a manual publish");
      expect(guard?.if).toContain("github.ref != 'refs/heads/main'");
      expect(guard?.run).toContain("exit 1");
    });
  });
});

describe("ci.yml", () => {
  const wf = parse(read(".github/workflows/ci.yml")) as Workflow;

  it("ci-ok aggregates every other job", () => {
    const others = Object.keys(wf.jobs)
      .filter((j) => j !== "ci-ok")
      .sort();
    expect([...((wf.jobs["ci-ok"] as Job).needs as string[])].sort()).toEqual(others);
  });

  it("the ci job runs the plugin checks, the skill checks and the marketplace check", () => {
    const text = jobText(wf.jobs.ci as Job);
    expect(text).toContain('capybara-plugin check --base \\"$(git rev-parse HEAD^1)\\"');
    expect(text).toContain(
      'capybara-plugin marketplace --check --base \\"$(git rev-parse HEAD^1)\\"',
    );
    expect(text).toContain("pnpm check:synced-skills");
    expect(text).toContain("pnpm check:skills-frontmatter");
    expect(text).toContain("pnpm lint");
    expect(text).toContain("pnpm typecheck");
  });
});

// While the first release is a release candidate, changesets run in pre mode, so a changeset
// versions 0.1.0-rc.0 to 0.1.0-rc.1, never to 0.1.0. The promotion PR runs `changeset pre exit`.
describe("changesets pre mode", () => {
  it("is on with the tag rc while a published plugin is a prerelease", () => {
    const slack = JSON.parse(read("plugins/slack/package.json")) as { version: string };
    if (!slack.version.includes("-")) return;
    const pre = JSON.parse(read(".changeset/pre.json")) as { mode: string; tag: string };
    expect(pre.tag).toBe("rc");
    expect(["pre", "exit"]).toContain(pre.mode);
  });
});
