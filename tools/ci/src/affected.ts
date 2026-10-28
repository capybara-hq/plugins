/**
 * Decides what the CI workflow runs on a pull request, from the list of changed files.
 *
 * Pushes to main always run everything (`planAll`). On a PR:
 * - docs-only diffs run no tests;
 * - "run everything" triggers (root config, the lockfile, which pins the core packages from npm,
 *   `.github/**`, `tools/**`, files that belong to no plugin and are not docs) run everything;
 * - otherwise the tests of each changed plugin run, plus every plugin that depends on it, by its
 *   `.capybara-plugin/plugin.json` dependencies or its package.json dependencies (all kinds,
 *   transitively).
 *
 * Erasable TypeScript only (no enums, no parameter properties): CI runs this file with plain
 * `node`, before any `pnpm install`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkspacePackage {
  /** Directory relative to the repo root, e.g. `plugins/slack`. */
  dir: string;
  /** npm package name. */
  name: string;
  /**
   * What it depends on: npm package names (any dependency kind) and, for a plugin, the plugin names
   * of its `plugin.json` dependencies prefixed with `plugin:` (e.g. `plugin:connector-mcp`).
   */
  deps: string[];
  /** The plugin name from `.capybara-plugin/plugin.json`, when the package is a plugin. */
  plugin?: string;
  /** Has a `test/` directory, i.e. vitest picks up files under it. */
  hasTests: boolean;
}

export interface Workspace {
  packages: WorkspacePackage[];
}

export interface Plan {
  /** Why this plan: shown in the job log. */
  reason: string;
  /** Run the whole suite (no path filter). */
  all: boolean;
  /** Package directories whose vitest tests run (empty when `all` or when no test runs). */
  testDirs: string[];
  test: boolean;
  /** Number of vitest shards. */
  shards: number;
}

/** Shard count for the full suite. */
export const FULL_SHARDS = 2;

/** Root files whose change can affect any test or build. */
const RUN_ALL_ROOT_FILES = new Set([
  "package.json",
  // Pins the core packages (@capybara-hq/plugin-sdk, testing, plugin-tools, model-fake) every
  // plugin builds and tests against: a core upgrade runs everything.
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "biome.json",
]);
const RUN_ALL_ROOT_PATTERNS = [/^vitest\.config\.[^/]+$/, /^tsconfig[^/]*\.json$/];
/** CI itself (workflows) and the repository tools (this plan, verify, the checks). */
const RUN_ALL_DIRS = [".github/", "tools/"];

/**
 * Files outside any workspace package that tests read, and the package directories whose tests
 * read them. When adding a test that reads such a file, add it here (otherwise it is either a doc
 * and ignored, or unknown and runs everything).
 */
const EXTRA_INPUTS: { match: (f: string) => boolean; dirs: string[] }[] = [
  // tools/worktree's tests execute the hooks directly.
  {
    match: (f) => f.startsWith(".claude/hooks/") || f === ".claude/settings.json",
    dirs: ["tools/worktree"],
  },
  // tools/checks' tests run the skill checks on this repository's skills.
  { match: (f) => f.startsWith(".agents/"), dirs: ["tools/checks"] },
];

/**
 * Files no test reads. The ci job checks the marketplace manifest in full on every PR
 * (`capybara-plugin marketplace --check`); changesets are consumed by the release workflow only.
 */
function isNoTestInput(f: string): boolean {
  if (f === ".capybara-plugin/marketplace.json") return true;
  return /^\.changeset\/[^/]+$/.test(f);
}

/** Docs: no test, build or check reads them. */
function isDoc(f: string): boolean {
  if (f.startsWith("docs/")) return true;
  if (f === ".gitignore") return true;
  if (f.startsWith(".claude/")) return true;
  return f.endsWith(".md");
}

function isRunAll(f: string): boolean {
  if (RUN_ALL_ROOT_FILES.has(f)) return true;
  if (RUN_ALL_ROOT_PATTERNS.some((re) => re.test(f))) return true;
  return RUN_ALL_DIRS.some((d) => f.startsWith(d));
}

export function planAll(reason: string): Plan {
  return { reason, all: true, testDirs: [], test: true, shards: FULL_SHARDS };
}

function planNone(reason: string): Plan {
  return { reason, all: false, testDirs: [], test: false, shards: 1 };
}

/** The workspace package a file belongs to (longest matching directory), if any. */
function owningPackage(f: string, ws: Workspace): WorkspacePackage | undefined {
  let best: WorkspacePackage | undefined;
  for (const p of ws.packages) {
    if (f.startsWith(`${p.dir}/`) && (best === undefined || p.dir.length > best.dir.length))
      best = p;
  }
  return best;
}

/** `start` plus everything reachable through `next`. */
function closure(start: Iterable<string>, next: (dir: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...start];
  for (let d = queue.pop(); d !== undefined; d = queue.pop()) {
    if (seen.has(d)) continue;
    seen.add(d);
    queue.push(...next(d));
  }
  return seen;
}

export function planFromFiles(files: string[], ws: Workspace): Plan {
  const changed = new Set<string>();
  for (const f of files.map((x) => x.trim()).filter((x) => x !== "")) {
    // Extra inputs first: `.claude/hooks/**` is not a doc although `.claude/**` is.
    const extra = EXTRA_INPUTS.find((e) => e.match(f));
    if (extra !== undefined) {
      for (const d of extra.dirs) changed.add(d);
      continue;
    }
    if (isRunAll(f)) return planAll(`run-everything trigger changed: ${f}`);
    const pkg = owningPackage(f, ws);
    if (pkg !== undefined) {
      changed.add(pkg.dir);
      continue;
    }
    if (isDoc(f) || isNoTestInput(f)) continue;
    return planAll(`file outside any workspace package: ${f}`);
  }
  if (changed.size === 0) return planNone("no test reads the changed files");

  // Dependency edges: npm package names and `plugin:<name>` both resolve to a package directory.
  const byKey = new Map<string, WorkspacePackage>();
  for (const p of ws.packages) {
    byKey.set(p.name, p);
    if (p.plugin !== undefined) byKey.set(`plugin:${p.plugin}`, p);
  }
  const byDir = new Map(ws.packages.map((p) => [p.dir, p]));
  const dependents = new Map<string, string[]>();
  for (const p of ws.packages) {
    for (const dep of p.deps) {
      const d = byKey.get(dep);
      if (d !== undefined && d.dir !== p.dir)
        dependents.set(d.dir, [...(dependents.get(d.dir) ?? []), p.dir]);
    }
  }

  const affected = closure(changed, (d) => dependents.get(d) ?? []);
  const testDirs = [...affected].filter((d) => byDir.get(d)?.hasTests === true).sort();
  return {
    reason: `changed packages: ${[...changed].sort().join(", ")}`,
    all: false,
    testDirs,
    test: testDirs.length > 0,
    shards: 1,
  };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/**
 * Reads the workspace packages (pnpm-workspace.yaml `dir/*` globs) with their package.json
 * dependencies and, for plugins, their `.capybara-plugin/plugin.json` name and dependencies.
 */
export function loadWorkspace(root: string): Workspace {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const block = /^packages:\n((?:[ \t]+-.*\n?)+)/m.exec(yaml);
  if (block?.[1] === undefined) throw new Error("pnpm-workspace.yaml: no packages list");
  const packages: WorkspacePackage[] = [];
  for (const line of block[1].split("\n").filter((l) => l.trim() !== "")) {
    const glob = /^\s+-\s+["']?([^"'\s]+)["']?\s*$/.exec(line)?.[1];
    const base = glob === undefined ? undefined : /^([\w.-]+)\/\*$/.exec(glob)?.[1];
    if (base === undefined)
      throw new Error(`pnpm-workspace.yaml: unsupported entry ${line.trim()}`);
    if (!existsSync(join(root, base))) continue;
    for (const e of readdirSync(join(root, base), { withFileTypes: true })) {
      const dir = `${base}/${e.name}`;
      const manifest = join(root, dir, "package.json");
      if (!e.isDirectory() || !existsSync(manifest)) continue;
      const pkg = readJson(manifest);
      const deps = new Set<string>();
      for (const kind of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const n of Object.keys((pkg[kind] as Record<string, string> | undefined) ?? {})) {
          deps.add(n);
        }
      }
      let plugin: string | undefined;
      const pluginJson = join(root, dir, ".capybara-plugin/plugin.json");
      if (existsSync(pluginJson)) {
        const pj = readJson(pluginJson);
        if (typeof pj.name !== "string") throw new Error(`${dir}: plugin.json has no name`);
        plugin = pj.name;
        // plugin.json dependencies: a list of { name, version } (version a semver range).
        const pd = Array.isArray(pj.dependencies) ? (pj.dependencies as unknown[]) : [];
        const names = pd.flatMap((x) => {
          const n = (x as { name?: unknown } | null)?.name;
          return typeof n === "string" ? [n] : [];
        });
        for (const n of names) deps.add(`plugin:${n}`);
      }
      packages.push({
        dir,
        name: String(pkg.name),
        deps: [...deps].sort(),
        ...(plugin === undefined ? {} : { plugin }),
        hasTests: existsSync(join(root, dir, "test")),
      });
    }
  }
  packages.sort((a, b) => a.dir.localeCompare(b.dir));
  return { packages };
}

/** GitHub Actions step outputs for a plan. */
export function toOutputs(plan: Plan): Record<string, string> {
  return {
    reason: plan.reason,
    test: String(plan.test),
    // Trailing slash: vitest filters are substring matches, and `plugins/openai` would also match
    // `plugins/openai-compatible`. Empty = no filter = the whole suite.
    "test-dirs": plan.testDirs.map((d) => `${d}/`).join(" "),
    "test-shards": JSON.stringify(Array.from({ length: plan.shards }, (_, i) => i + 1)),
    "test-shard-total": String(plan.shards),
  };
}
