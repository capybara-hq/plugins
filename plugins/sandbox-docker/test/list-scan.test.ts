import { randomUUID } from "node:crypto";
import {
  DEVICE_SCAN_SKIPPED_BASE_DIRS,
  DEVICE_SCAN_SKIPPED_DIRS,
  isSandboxGoneError,
  MAX_DEVICE_SCAN_DIRS,
  MAX_DEVICE_SCAN_RESULTS,
  type SandboxActor,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerSandbox } from "../src/index.js";
import {
  buildTestImages,
  cleanupTestResources,
  docker,
  dockerAvailable,
  type SocketProxy,
  startSocketProxy,
  TEST_LABEL,
  type TestImages,
} from "./docker-env.js";

/**
 * `list` / `scan` (project root, core spec 2026-11-14 §4.1, §4.2) on real Docker: read inside the
 * container as the sandbox user, the container's workspace being the whole reachable area in either
 * mode. The case list follows core's device tests (its listing and docker executor tests).
 * Skipped without Docker.
 */

const RUN = randomUUID().slice(0, 8);
const sig = () => AbortSignal.timeout(120_000);
const actor: SandboxActor = { accountId: "acc-1", conversationId: "conv-1" };
type Mode = SandboxLimits["mode"];
const limits = (): SandboxLimits => ({
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  mode: "auto",
  network: { kind: "allowlist", hosts: [] },
});

describe.skipIf(!dockerAvailable)("sandbox-docker list and scan", { timeout: 120_000 }, () => {
  let images: TestImages;
  let proxy: SocketProxy;
  const netName = `capybara-sandbox-test-${RUN}`;
  let sbx: SandboxProvider;
  let h: SandboxHandle;

  const create = async () => {
    const name = `cap-${randomUUID()}`;
    const fileSystem = await sbx.createFileSystem({ name, limits: limits(), signal: sig() });
    return sbx.create({
      name,
      image: images.sandboxImage,
      limits: limits(),
      fileSystem,
      signal: sig(),
    });
  };

  beforeAll(async () => {
    [images, proxy] = await Promise.all([
      buildTestImages(),
      startSocketProxy(),
      docker("network", "create", "--label", `${TEST_LABEL}=${RUN}`, netName),
    ]);
    sbx = createDockerSandbox(
      {
        endpoint: proxy.endpoint,
        runtime: "runc",
        network: netName,
        egressProxyImage: images.egressImage,
      },
      { labels: { [TEST_LABEL]: RUN } },
    );
    h = await create();
    // a cold run builds the sandbox image (about 1.5 GB) once, shared by the files
  }, 1_200_000);

  afterAll(async () => {
    await cleanupTestResources(RUN);
    await proxy?.stop();
    await images?.remove();
  }, 120_000);

  /** Runs `script` in a fresh directory under /workspace as the sandbox user; returns that directory. */
  const fixture = async (script: string, on: SandboxHandle = h) => {
    const dir = `/workspace/t-${randomUUID().slice(0, 8)}`;
    const r = await sbx.exec(on, {
      command: `set -e; mkdir -p ${dir}; cd ${dir}; ${script}`,
      timeoutMs: 60_000,
      maxOutputBytes: 10_000,
      signal: sig(),
      tag: "fixture",
      actor,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    return dir;
  };
  const list = (path: string, limit = 100, mode: Mode = "auto", signal = sig(), on = h) => {
    if (sbx.list === undefined) throw new Error("sandbox-docker offers no list");
    return sbx.list(on, path, { limit, limits: { mode }, signal });
  };
  const scan = (base: string, mode: Mode = "auto", signal = sig(), on = h) => {
    if (sbx.scan === undefined) throw new Error("sandbox-docker offers no scan");
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
      // a link into the workspace lists its target
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

    it("lists the workspace itself", async () => {
      const d = await fixture("true");
      const r = await list("/workspace", 1000);
      expect(r?.entries).toContainEqual({ name: d.slice("/workspace/".length), isDir: true });
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

    it("starts a stopped container first", async () => {
      const own = await create();
      const d = await fixture("mkdir -p p/.git", own);
      await docker("stop", "-t", "0", own.id);
      expect(await list(d, 10, "auto", sig(), own)).toEqual({
        entries: [{ name: "p", isDir: true }],
        truncated: false,
      });
      await docker("stop", "-t", "0", own.id);
      expect(await scan(d, "auto", sig(), own)).toEqual([{ path: `${d}/p`, suggestedName: "p" }]);
    });

    it("a removed container is SandboxGoneError", async () => {
      const own = await create();
      await docker("rm", "-f", own.id);
      for (const op of [
        () => list("/workspace", 10, "auto", sig(), own),
        () => scan("/workspace", "auto", sig(), own),
      ]) {
        expect(isSandboxGoneError(await op().catch((e: unknown) => e))).toBe(true);
      }
    });
  });
});
