import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_SCAN_SKIPPED_BASE_DIRS,
  DEVICE_SCAN_SKIPPED_DIRS,
  isSandboxGoneError,
  type Logger,
  MAX_DEVICE_SCAN_DIRS,
  MAX_DEVICE_SCAN_RESULTS,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { type FakeE2BServer, startFakeE2B } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createE2BSandbox, publishedImage } from "../src/index.js";

/**
 * `list` / `scan` (project root, core spec 2026-11-14 §4.1, §4.2) on E2B, against the fake E2B
 * (startFakeE2B: commands run on this machine with the sandbox roots mapped to a temp directory):
 * read inside the sandbox through its command execution, the workspace being the whole reachable
 * area in either mode. The case list follows core's device tests (its listing and docker executor
 * tests) and the same cases in the Docker plugin.
 */

const sig = () => AbortSignal.timeout(20_000);
type Mode = SandboxLimits["mode"];
const limits = (): SandboxLimits => ({
  cpu: 1,
  memoryMb: 2048,
  diskMb: 5120,
  mode: "sandbox",
  network: { kind: "allowlist", hosts: [] },
});
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("sandbox-e2b list and scan (fake E2B)", { timeout: 20_000 }, () => {
  let fake: FakeE2BServer;
  let sbx: SandboxProvider;
  let h: SandboxHandle;

  const provision = async () => {
    const name = `cap-device-${randomUUID()}`;
    const fileSystem = await sbx.createFileSystem({ name, limits: limits(), signal: sig() });
    return sbx.create({ name, limits: limits(), fileSystem, signal: sig() });
  };

  beforeAll(async () => {
    fake = await startFakeE2B();
    sbx = createE2BSandbox(
      {
        apiKey: fake.apiKey,
        apiUrl: fake.url,
        domain: "e2b.app",
        template: "capybara-sandbox",
        defaultImage: publishedImage("0.0.0-test.1"),
        timeoutSeconds: 3600,
        domainAllowlist: true,
      },
      { log: silent },
      { envdUrl: fake.url },
    );
    h = await provision();
  });
  afterAll(async () => {
    // the fixtures close some directories (chmod 000); open them so the fake can remove its root
    await sbx
      .exec(h, {
        command: "chmod -R u+rwx /workspace",
        timeoutMs: 10_000,
        maxOutputBytes: 1000,
        signal: sig(),
        tag: "cleanup",
        actor: { accountId: "acc-1", conversationId: "conv-1" },
      })
      .catch(() => undefined);
    await fake?.close();
  });

  /** Runs `script` in a fresh directory under /workspace; returns that directory. */
  const fixture = async (script: string) => {
    const dir = `/workspace/t-${randomUUID().slice(0, 8)}`;
    const r = await sbx.exec(h, {
      command: `set -e; mkdir -p ${dir}; cd ${dir}; ${script}`,
      timeoutMs: 15_000,
      maxOutputBytes: 10_000,
      signal: sig(),
      tag: "fixture",
      actor: { accountId: "acc-1", conversationId: "conv-1" },
    });
    expect(r.exitCode, r.stderr).toBe(0);
    return dir;
  };
  const list = (path: string, limit = 100, mode: Mode = "auto", signal = sig(), on = h) => {
    if (sbx.list === undefined) throw new Error("sandbox-e2b offers no list");
    return sbx.list(on, path, { limit, limits: { mode }, signal });
  };
  const scan = (base: string, mode: Mode = "auto", signal = sig(), on = h) => {
    if (sbx.scan === undefined) throw new Error("sandbox-e2b offers no scan");
    return sbx.scan(on, base, { limits: { mode }, signal });
  };
  const names = async (base: string) => (await scan(base)).map((c) => c.path.slice(base.length));

  describe("list", () => {
    it("sorts entries by code unit and says which are directories, in either mode", async () => {
      const d = await fixture("mkdir B a; : > _x; : > é");
      for (const mode of ["auto", "sandbox"] as const) {
        expect(await list(d, 10, mode)).toEqual({
          entries: [
            { name: "B", isDir: true },
            { name: "_x", isDir: false },
            { name: "a", isDir: true },
            { name: "é", isDir: false },
          ],
          truncated: false,
        });
      }
    });

    it("cuts at the limit and says it was truncated", async () => {
      const d = await fixture("mkdir a b c");
      expect(await list(d, 2)).toEqual({
        entries: [
          { name: "a", isDir: true },
          { name: "b", isDir: true },
        ],
        truncated: true,
      });
      expect((await list(d, 3))?.truncated).toBe(false);
      expect(await list(d, 0)).toEqual({ entries: [], truncated: true });
      await expect(list(d, -1)).rejects.toThrow(/limit/);
    });

    it("isDir follows links: to a directory true; dangling or leaving the workspace false", async () => {
      const d = await fixture(
        "mkdir target; ln -s $PWD/target link; ln -s $PWD/nowhere dangling; ln -s /etc etc; ln -s /tmp tmp",
      );
      expect((await list(d))?.entries).toEqual([
        { name: "dangling", isDir: false },
        { name: "etc", isDir: false },
        { name: "link", isDir: true },
        { name: "target", isDir: true },
        { name: "tmp", isDir: false },
      ]);
      expect(await list(`${d}/link`)).toEqual({ entries: [], truncated: false });
    });

    it("null for a missing path, a path below a file and a dangling link", async () => {
      const d = await fixture(": > f; ln -s $PWD/nowhere dangling");
      expect(await list(`${d}/missing`)).toBeNull();
      expect(await list(`${d}/f/below`)).toBeNull();
      expect(await list(`${d}/dangling`)).toBeNull();
    });

    it("throws for a file and for a directory that cannot be read", async () => {
      const d = await fixture(": > f; mkdir closed; chmod 000 closed");
      await expect(list(`${d}/f`)).rejects.toThrow(/not a directory/);
      await expect(list(`${d}/closed`)).rejects.toThrow(/cannot be read/);
    });

    it("throws for a path outside the workspace, also through a link, in either mode", async () => {
      const d = await fixture("ln -s /etc etc");
      for (const mode of ["auto", "sandbox"] as const) {
        for (const path of ["/", "/etc", "/tmp", "/skills", "/workspacex", `${d}/etc`]) {
          await expect(list(path, 10, mode), `${mode} ${path}`).rejects.toThrow(/outside/);
        }
      }
      await expect(list("/workspace/../etc")).rejects.toThrow(/path/);
      await expect(list("relative")).rejects.toThrow(/path/);
    });

    it("runs as the sandbox user, the script and its arguments passed as argv", async () => {
      const d = await fixture("mkdir 'a $(touch x)'");
      expect((await list(d))?.entries).toEqual([{ name: "a $(touch x)", isDir: true }]);
      const start = fake.calls.filter((c) => c.path === "/process.Process/Start").at(-1);
      expect(start?.user).toBe("sandbox");
    });
  });

  describe("scan", () => {
    it("finds the base and directories two levels down holding .git or AGENTS.md", async () => {
      const b = await fixture(
        "mkdir -p .git one/.git two/deep plain/x two/deep/three/.git agents-dir/AGENTS.md wt; " +
          ": > two/deep/AGENTS.md; echo 'gitdir: elsewhere' > wt/.git",
      );
      const leaf = b.slice(b.lastIndexOf("/") + 1);
      expect(await scan(b)).toEqual([
        { path: b, suggestedName: leaf },
        { path: `${b}/one`, suggestedName: "one" },
        { path: `${b}/two/deep`, suggestedName: "deep" },
        { path: `${b}/wt`, suggestedName: "wt" },
      ]);
    });

    it("keeps descending after a hit (a monorepo's sub-projects are candidates too)", async () => {
      const b = await fixture("mkdir -p mono/.git mono/pkg/.git");
      expect(await names(b)).toEqual(["/mono", "/mono/pkg"]);
    });

    it("skips hidden directories, node_modules, Library under the base, and links", async () => {
      const b = await fixture(
        "mkdir -p .hidden/p/.git node_modules/p/.git x/node_modules/.git Library/p/.git " +
          "x/Library/.git ../elsewhere-$$/p/.git; ln -s $PWD/../elsewhere-$$ link",
      );
      expect(await names(b)).toEqual(["/x/Library"]);
    });

    it("skips exactly the SDK's directory lists", async () => {
      const dirs = [
        ...DEVICE_SCAN_SKIPPED_DIRS.map((n) => `x/${n}/p/.git`),
        ...DEVICE_SCAN_SKIPPED_BASE_DIRS.map((n) => `${n}/p/.git`),
      ];
      const b = await fixture(`mkdir -p ${dirs.join(" ")}`);
      expect(await scan(b)).toEqual([]);
    });

    it("never returns a directory whose name breaks the rule, but walks below it", async () => {
      const b = await fixture(
        `mkdir -p ' lead/.git' ' lead/inner/.git' ${"n".repeat(65)}/.git ok/.git`,
      );
      expect(await names(b)).toEqual(["/ lead/inner", "/ok"]);
    });

    it(`answers the first ${MAX_DEVICE_SCAN_RESULTS} by path`, async () => {
      const b = await fixture("for i in $(seq -w 0 59); do mkdir -p p$i/.git; done");
      const found = await scan(b);
      expect(found).toHaveLength(MAX_DEVICE_SCAN_RESULTS);
      expect(found[0]?.suggestedName).toBe("p00");
      expect(found.at(-1)?.suggestedName).toBe("p49");
    });

    it(`reads at most ${MAX_DEVICE_SCAN_DIRS} directories`, async () => {
      const b = await fixture(
        `for i in $(seq -w 0 ${MAX_DEVICE_SCAN_DIRS + 19}); do mkdir d$i; done; ` +
          "mkdir -p a-first/.git zz-last/.git",
      );
      expect(await names(b)).toEqual(["/a-first"]);
    });

    it("visits each level in code-unit order of path, not parent by parent", async () => {
      // base + 497 directories on the first level leave two visits for the second: by path,
      // "a-x/c" and "a-x/d" come before "a/b" ("-" sorts before "/")
      const b = await fixture(
        `for i in $(seq -w 0 ${MAX_DEVICE_SCAN_DIRS - 6}); do mkdir f$i; done; ` +
          "mkdir -p a/b/.git a-x/c/.git a-x/d/.git",
      );
      expect(await names(b)).toEqual(["/a-x/c", "/a-x/d"]);
    });

    it("an unreadable subdirectory is skipped (it still counts as a visit)", async () => {
      const b = await fixture("mkdir -p closed/p/.git open/.git; chmod 000 closed");
      expect(await names(b)).toEqual(["/open"]);
    });

    it("[] for a missing base; throws for a file, an unreadable or an outside base", async () => {
      const d = await fixture(": > f; mkdir closed; chmod 000 closed; ln -s /etc etc");
      expect(await scan(`${d}/missing`)).toEqual([]);
      await expect(scan(`${d}/f`)).rejects.toThrow(/not a directory/);
      await expect(scan(`${d}/closed`)).rejects.toThrow(/cannot be read/);
      for (const mode of ["auto", "sandbox"] as const) {
        for (const base of ["/", "/home", "/tmp", `${d}/etc`]) {
          await expect(scan(base, mode), `${mode} ${base}`).rejects.toThrow(/outside/);
        }
      }
    });

    it("scans through a base that is a link inside the workspace, reporting the path asked for", async () => {
      const d = await fixture("mkdir -p real/p/.git; ln -s $PWD/real alias");
      expect(await scan(`${d}/alias`)).toEqual([{ path: `${d}/alias/p`, suggestedName: "p" }]);
    });
  });

  describe("the provider's semantics", () => {
    it("rejects at once when the signal is already aborted", async () => {
      const ac = new AbortController();
      ac.abort(new Error("stop"));
      await expect(list("/workspace", 10, "auto", ac.signal)).rejects.toThrow(/stop/);
      await expect(scan("/workspace", "auto", ac.signal)).rejects.toThrow(/stop/);
    });

    it("an abort in flight rejects with its reason", async () => {
      const ops = [
        (s: AbortSignal) => list("/workspace", 10, "auto", s),
        (s: AbortSignal) => scan("/workspace", "auto", s),
      ];
      for (const op of ops) {
        const starts = () => fake.calls.filter((c) => c.path === "/process.Process/Start").length;
        const seen = starts();
        fake.hangNext({ method: "POST", path: /\/process\.Process\/Start$/ });
        const ac = new AbortController();
        const p = op(ac.signal);
        // the hanging start reached the fake (so the hang is used up, not left for later tests)
        await waitFor(() => starts() > seen);
        ac.abort(new Error("lost lock"));
        await expect(p).rejects.toThrow(/lost lock/);
      }
    });

    it("a template without python3 is a clear error", async () => {
      const empty = mkdtempSync(join(tmpdir(), "no-python-"));
      const path = process.env.PATH;
      // the fake runs commands with this process's PATH (after its shims): an empty directory
      // leaves the sandbox shell without python3
      process.env.PATH = empty;
      try {
        await expect(list("/workspace")).rejects.toThrow(/no python3/);
        await expect(scan("/workspace")).rejects.toThrow(/no python3/);
      } finally {
        process.env.PATH = path;
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it("a sandbox that is gone is SandboxGoneError", async () => {
      const g = await provision();
      await fake.expire(g.id);
      for (const op of [
        () => list("/workspace", 10, "auto", sig(), g),
        () => scan("/workspace", "auto", sig(), g),
      ]) {
        expect(isSandboxGoneError(await op().catch((e: unknown) => e))).toBe(true);
      }
    });
  });
});
