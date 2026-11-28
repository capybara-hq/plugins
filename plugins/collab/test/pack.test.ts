import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { CLIENT_API_VERSION, parsePluginManifest } from "@capybara-hq/plugin-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { EVENT_TYPES, TOOL_KEYS } from "../src/constants.js";

/**
 * The plugin through the published toolchain (`capybara-plugin` from the workspace root, where
 * vitest runs): `check` is clean (no warning either) and `pack` ships the manifest, the
 * extension and its client build, the migrations, the agent templates and the skills, and the
 * packed manifest carries the permissions the README explains.
 */
const pluginDir = fileURLToPath(new URL("../", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "collab-pack-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  execFileSync("pnpm", ["exec", "capybara-plugin", ...args], { encoding: "utf8" });

/** stdout and stderr of a command (check prints its warnings on stderr). */
const cliAll = (...args: string[]) => {
  const r = spawnSync("pnpm", ["exec", "capybara-plugin", ...args], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};

/** The files of a gzipped tar by name (ustar headers; enough for npm-pack tarballs). */
function tarFiles(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, len: number) =>
      header
        .subarray(from, from + len)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    files.set(prefix === "" ? name : `${prefix}/${name}`, tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe("collab package", () => {
  it("passes capybara-plugin check", () => {
    const report = cliAll("check", "--plugins", "plugins/collab");
    expect(report).toContain("All plugin checks passed");
    expect(report.split("\n").filter((l) => /^\s+\S+:\d+ \S+ /.test(l))).toEqual([]);
    expect(report).not.toMatch(/warning/);
  }, 60_000);

  it("packs the manifest, extension, client build, migrations, agents and skills", () => {
    cli("pack", pluginDir, "--out", out);
    const tgzs = readdirSync(out).filter((f) => f.endsWith(".tgz"));
    expect(tgzs).toEqual([expect.stringMatching(/^capybara-hq-plugin-collab-.*\.tgz$/)]);
    const files = tarFiles(readFileSync(join(out, tgzs[0] ?? "")));
    const entries = [...files.keys()];
    expect(entries).toEqual(
      expect.arrayContaining([
        "package/.capybara-plugin/plugin.json",
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
        "package/icon.svg",
        "package/migrations/0001_init.sql",
        "package/migrations/0002_item_watchers.sql",
        "package/agents/product.md",
        "package/agents/engineer.md",
        "package/agents/qa.md",
        "package/skills/collab-workflow/SKILL.md",
        "package/skills/prd-writing/SKILL.md",
        "package/skills/test-planning/SKILL.md",
      ]),
    );
    // the bundled extension and its client build, no other dist files (no tsc output, no maps)
    expect(entries.filter((e) => e.startsWith("package/dist/")).sort()).toEqual([
      "package/dist/client/client.mjs",
      "package/dist/index.mjs",
    ]);

    const parsed = parsePluginManifest(
      JSON.parse(files.get("package/.capybara-plugin/plugin.json")?.toString("utf8") ?? "{}"),
    );
    if ("errors" in parsed) throw new Error(parsed.errors.join("\n"));
    expect(parsed.name).toBe("collab");
    expect(parsed.skills?.map((s) => s.path).sort()).toEqual([
      "./skills/collab-workflow",
      "./skills/prd-writing",
      "./skills/test-planning",
    ]);
    expect(parsed.agents?.map((a) => a.path).sort()).toEqual([
      "./agents/engineer.md",
      "./agents/product.md",
      "./agents/qa.md",
    ]);
    const ext = parsed.extension;
    expect(ext?.client?.entry).toBe("./dist/client/client.mjs");
    expect(ext?.client?.apiVersion).toBe(CLIENT_API_VERSION);
    const permissions = ext?.manifest.permissions;
    expect(permissions).toMatchObject({
      tools: [...TOOL_KEYS],
      triggers: { emit: [...EVENT_TYPES] },
      inbox: true,
      agents: { read: true },
      conversations: { subjects: true },
      people: { read: true },
      hooks: ["run.lifecycle"],
      client: true,
    });
    // nothing the README does not explain (no storage, network, sandbox, models...)
    expect(Object.keys(permissions ?? {}).sort()).toEqual(
      [
        "agents",
        "client",
        "conversations",
        "hooks",
        "inbox",
        "people",
        "tools",
        "triggers",
        "ui",
      ].sort(),
    );
    // the migrations ship as written
    expect(files.get("package/migrations/0001_init.sql")?.toString("utf8")).toBe(
      readFileSync(join(pluginDir, "migrations/0001_init.sql"), "utf8"),
    );
  }, 60_000);
});
