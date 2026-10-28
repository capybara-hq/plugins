import { describe, expect, it } from "vitest";
import { type DoctorEnv, runDoctor } from "../src/doctor.ts";
import { printReport } from "../src/report.ts";

function makeEnv(over: Partial<DoctorEnv> & { missing?: string[] } = {}): DoctorEnv {
  const { missing = [], ...rest } = over;
  return {
    root: "/repo",
    nodeVersion: "v24.1.0",
    home: "/home/u",
    exec(cmd, args) {
      if (missing.includes(cmd)) return { status: 127, stdout: "" };
      if (cmd === "pnpm") return { status: 0, stdout: "10.4.0\n" };
      if (cmd === "git" && args[1] === "--get-regexp") {
        return {
          status: 0,
          stdout: "remote.origin.url https://github.com/capybara-hq/plugins.git\n",
        };
      }
      if (cmd === "git" && args[0] === "config") {
        return { status: 0, stdout: args[1] === "user.name" ? "Grant\n" : "g@example.com\n" };
      }
      return { status: 0, stdout: "" };
    },
    fileExists: () => false,
    readFile: (p) => (p.endsWith("lock.yaml") ? "lock-v1" : null),
    isSymlinkTo: () => true,
    ...rest,
  };
}

const byId = (checks: Awaited<ReturnType<typeof runDoctor>>, id: string) => {
  const c = checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check ${id}`);
  return c;
};

describe("runDoctor", () => {
  it("all green", async () => {
    const checks = await runDoctor(
      makeEnv({ fileExists: (p) => p === "/home/u/.capybara-test.env" }),
    );
    expect(checks.map((c) => c.id)).toEqual([
      "node",
      "pnpm",
      "deps",
      "docker",
      "skills-link",
      "remotes",
      "git-identity",
      "gh",
      "live-api-env",
    ]);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
    expect(printReport(checks, true)).toBe(0);
  });

  it("detects the upstream from raw config urls (what insteadOf rewrites hide)", async () => {
    const base = makeEnv({ fileExists: (p) => p === "/home/u/.capybara-test.env" });
    const checks = await runDoctor({
      ...base,
      exec(cmd, args) {
        if (cmd === "git" && args[1] === "--get-regexp") {
          return {
            status: 0,
            stdout:
              "remote.origin.url git@github.com:me/plugins.git\n" +
              "remote.upstream.url https://github.com/capybara-hq/plugins.git\n",
          };
        }
        return base.exec(cmd, args);
      },
    });
    expect(byId(checks, "remotes").detail).toContain('upstream is "upstream"');
  });

  it("node 22 fails node", async () => {
    const checks = await runDoctor(makeEnv({ nodeVersion: "v22.3.0" }));
    expect(byId(checks, "node").status).toBe("fail");
    expect(printReport(checks, true)).toBe(1);
  });

  it("lockfile differs fails deps with fix", async () => {
    const checks = await runDoctor(
      makeEnv({ readFile: (p) => (p.endsWith("node_modules/.pnpm/lock.yaml") ? "old" : "new") }),
    );
    expect(byId(checks, "deps")).toMatchObject({ status: "fail", fix: "pnpm install" });
  });

  it(".claude/skills as a text file fails skills-link", async () => {
    const checks = await runDoctor(makeEnv({ isSymlinkTo: () => false }));
    const c = byId(checks, "skills-link");
    expect(c.status).toBe("fail");
    expect(c.fix).toContain("git config core.symlinks true");
  });

  it("gh missing warns, ok stays true", async () => {
    const checks = await runDoctor(makeEnv({ missing: ["gh"] }));
    expect(byId(checks, "gh").status).toBe("warn");
    expect(printReport(checks, true)).toBe(0);
  });

  it("live-api-env skipped when absent and never read", async () => {
    const checks = await runDoctor(
      makeEnv({
        readFile: (p) => {
          if (p.includes(".capybara-test.env")) throw new Error("must not read the env file");
          return p.endsWith("lock.yaml") ? "x" : null;
        },
      }),
    );
    expect(byId(checks, "live-api-env").status).toBe("skip");
  });
});
