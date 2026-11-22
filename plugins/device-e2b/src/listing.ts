import { posix } from "node:path";
import {
  DEVICE_SCAN_SKIPPED_BASE_DIRS,
  DEVICE_SCAN_SKIPPED_DIRS,
  isDeviceProjectName,
  MAX_DEVICE_LIST_ENTRIES,
  MAX_DEVICE_SCAN_DEPTH,
  MAX_DEVICE_SCAN_DIRS,
  MAX_DEVICE_SCAN_RESULTS,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";

/*
 * `DeviceProvider.list` / `scan` read inside the instance: one python3 script run as the sandbox
 * user. KEEP IN STEP: this file is duplicated, byte for byte, in plugins/device-docker/src/listing.ts
 * and plugins/device-e2b/src/listing.ts (the plugins share no code package;
 * tools/checks/test/sandbox-listing.test.ts asserts they are identical). It follows the rules of
 * core's local device in docker mode (`packages/device/src/exec/docker.ts`, `LIST_SCRIPT`, and
 * `exec/listing.ts`); it is not the same script.
 */

/** The whole area a cloud device offers, in either mode (core spec 2026-11-14 project root §4.2). */
export const LIST_AREA = "/workspace";

/** The in-instance time limit of one `list` / `scan` (`timeout -s KILL`), as core's device. */
export const LIST_TIMEOUT_SECONDS = 30;

/**
 * The PATH the list command runs with: the system directories only. The image's own PATH starts
 * with /workspace/.cache/npm-global/bin, which the sandbox user can write, so `timeout` and
 * `python3` are never looked up there.
 */
export const LIST_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * The most output a `list` / `scan` script writes: up to {@link MAX_DEVICE_LIST_ENTRIES} names as
 * ASCII-only JSON (every non-ASCII code unit escaped to six bytes) fit well within it.
 */
export const LIST_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * argv after the script: `<op> <path> <limit>`, the path already normalized and lexically under
 * {@link LIST_AREA} (passed as argv, never interpolated into code). The rules of core's
 * `listDirectory` / `scanDirectory` with the workspace as the area: real-path containment (a link
 * whose target leaves the workspace is not a directory, and a path that resolves outside it is
 * refused before anything is looked up there, so a refusal never tells whether it exists), null /
 * [] for a missing path, the breadth-first walk and its budget. Names sort by UTF-16 code unit
 * (`utf-16-be` bytes). The workspace's own real path is resolved first, so containment holds
 * wherever it is mounted. stdout is one JSON object: `{"r": ...}` or `{"e": "policy" | "notdir" |
 * "read", "c": errno name}`; scan answers the candidates' paths relative to the base ("" for the
 * base), which the caller joins to the base it was asked for.
 */
export const LIST_SCRIPT = `
import errno, json, os, stat, sys
op, p, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
L = "${LIST_AREA}"
W = os.path.realpath(L)
def out(o):
    sys.stdout.write(json.dumps(o)); sys.exit(0)
def key(s):
    return s.encode("utf-16-be", "surrogatepass")
def under(r, a):
    return r == a or r.startswith(a + "/")
def fail(e):
    out({"e": "read", "c": errno.errorcode.get(getattr(e, "errno", None) or 0, "")})
def plain_dir(e):
    try:
        return e.is_dir(follow_symlinks=False)
    except OSError:
        return False
q = os.path.normpath(p)
if not os.path.isabs(q) or not under(q, L):
    out({"e": "policy"})
try:
    r = os.path.realpath(q)
except OSError as e:
    fail(e)
if not under(r, W):
    out({"e": "policy"})
try:
    st = os.stat(r)
except (FileNotFoundError, NotADirectoryError):
    out({"r": None if op == "list" else []})
except OSError as e:
    fail(e)
if not stat.S_ISDIR(st.st_mode):
    out({"e": "notdir"})
try:
    with os.scandir(r) as it:
        ents = sorted(it, key=lambda e: key(e.name))
except OSError as e:
    fail(e)
def is_dir(d, e):
    try:
        if e.is_dir(follow_symlinks=False):
            return True
        if not e.is_symlink():
            return False
        t = os.path.realpath(os.path.join(d, e.name))
        return under(t, W) and os.path.isdir(t)
    except OSError:
        return False
if op == "list":
    out({"r": {"entries": [{"name": e.name, "isDir": is_dir(r, e)} for e in ents[:limit]], "truncated": len(ents) > limit}})
skip_any = ${JSON.stringify(DEVICE_SCAN_SKIPPED_DIRS)}
skip_base = ${JSON.stringify(DEVICE_SCAN_SKIPPED_BASE_DIRS)}
found = []
def below(d, rel, es, depth):
    if any(e.name == ".git" or (e.name == "AGENTS.md" and not plain_dir(e)) for e in es):
        found.append(rel)
    if depth >= ${MAX_DEVICE_SCAN_DEPTH}:
        return []
    return [(os.path.join(d, e.name), e.name if rel == "" else rel + "/" + e.name) for e in es
            if plain_dir(e) and not e.name.startswith(".")
            and e.name not in skip_any and not (depth == 0 and e.name in skip_base)]
visits = 1
level = below(r, "", ents, 0)
depth = 1
while level and visits < ${MAX_DEVICE_SCAN_DIRS}:
    level.sort(key=lambda n: key(n[1]))
    nxt = []
    for d, rel in level:
        if visits >= ${MAX_DEVICE_SCAN_DIRS}:
            break
        visits += 1
        try:
            with os.scandir(d) as it:
                es = list(it)
        except OSError:
            continue
        nxt.extend(below(d, rel, es, depth))
    level = nxt
    depth += 1
out({"r": found})
`;

/**
 * Checks `path` before anything runs and returns it normalized (`.` / `..` segments resolved, no
 * trailing slash), which is what the script reads and what scan results are built on: the shape
 * (absolute, no control characters), then that it lies lexically under {@link LIST_AREA}; a cloud
 * device offers nothing else, whatever the mode.
 */
export function checkListPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`invalid sandbox path ${JSON.stringify(path)}: path must be absolute`);
  }
  let p = posix.normalize(path);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const errors = validateSandboxPathShape(p);
  if (errors.length > 0) {
    throw new Error(`invalid sandbox path ${JSON.stringify(path)}: ${errors.join("; ")}`);
  }
  if (p !== LIST_AREA && !p.startsWith(`${LIST_AREA}/`)) throw outside(path);
  return p;
}

/** The entries one `list` asks the script for: `limit`, at most {@link MAX_DEVICE_LIST_ENTRIES}. */
export function listLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`list limit must be a non-negative integer, got ${String(limit)}`);
  }
  return Math.min(limit, MAX_DEVICE_LIST_ENTRIES);
}

const outside = (path: string) =>
  new Error(
    `${path} is outside the sandbox's workspace (${LIST_AREA}); a cloud device offers only that, in either mode`,
  );

/** What the script run answered (the provider's exec result). */
export interface ListRun {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
}

/**
 * The script's answer, or the error it reports. `noPython` is the provider's message for an image
 * without python3 or timeout (`timeout` / the shell answer 127); 137 is the in-instance time limit.
 */
function answerOf(op: "list" | "scan", path: string, run: ListRun, noPython: string): unknown {
  const text = (b: Uint8Array) => Buffer.from(b).toString("utf8").trim().slice(0, 300);
  if (run.exitCode === 127) throw new Error(noPython);
  if (run.exitCode === 137) {
    throw new Error(
      `${op} ${path} took longer than ${LIST_TIMEOUT_SECONDS} s and was stopped; try a smaller directory or a base further down`,
    );
  }
  let res: { r?: unknown; e?: unknown; c?: unknown } | undefined;
  if (run.exitCode === 0 && !run.truncated) {
    try {
      res = JSON.parse(Buffer.from(run.stdout).toString("utf8"));
    } catch {
      res = undefined;
    }
  }
  if (res === undefined || typeof res !== "object" || res === null) {
    const why = run.exitCode === 0 ? "an unreadable answer" : `exit code ${String(run.exitCode)}`;
    throw new Error(`${op} ${path} failed in the sandbox (${why}): ${text(run.stderr)}`);
  }
  if (res.e === "policy") throw outside(path);
  if (res.e === "notdir") throw new Error(`${path} is not a directory`);
  if (res.e === "read") {
    const code = typeof res.c === "string" && /^[A-Z0-9_]+$/.test(res.c) ? ` (${res.c})` : "";
    throw new Error(`${path} cannot be read${code}`);
  }
  if (res.e !== undefined) throw new Error(`${op} ${path} failed in the sandbox`);
  return res.r ?? null;
}

/** `list`'s result from the script run. */
export function finishList(
  path: string,
  run: ListRun,
  noPython: string,
): { entries: { name: string; isDir: boolean }[]; truncated: boolean } | null {
  const r = answerOf("list", path, run, noPython);
  if (r === null) return null;
  const v = r as { entries?: unknown; truncated?: unknown };
  if (
    !Array.isArray(v.entries) ||
    typeof v.truncated !== "boolean" ||
    !v.entries.every(
      (e: { name?: unknown; isDir?: unknown } | null) =>
        typeof e?.name === "string" && typeof e.isDir === "boolean",
    )
  ) {
    throw new Error(`list ${path} answered an invalid result`);
  }
  return {
    entries: (v.entries as { name: string; isDir: boolean }[]).map((e) => ({
      name: e.name,
      isDir: e.isDir,
    })),
    truncated: v.truncated,
  };
}

/** `a` before `b` in UTF-16 code-unit order (locale-independent). */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `scan`'s result from the script run (core's `finishScan`): each found path joined to `base`,
 * candidates whose basename satisfies the project name rule and whose path has a valid shape (others
 * skipped, never renamed), sorted by path in code-unit order, the first
 * {@link MAX_DEVICE_SCAN_RESULTS}.
 */
export function finishScan(
  base: string,
  run: ListRun,
  noPython: string,
): { path: string; suggestedName: string }[] {
  const r = answerOf("scan", base, run, noPython);
  if (!Array.isArray(r) || !r.every((x) => typeof x === "string")) {
    throw new Error(`scan ${base} answered an invalid result`);
  }
  const out: { path: string; suggestedName: string }[] = [];
  const seen = new Set<string>();
  for (const rel of r as string[]) {
    const path = rel === "" ? base : `${base}/${rel}`;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (seen.has(path) || !isDeviceProjectName(name)) continue;
    if (validateSandboxPathShape(path).length > 0) continue;
    seen.add(path);
    out.push({ path, suggestedName: name });
  }
  return out.sort((a, b) => byCodeUnit(a.path, b.path)).slice(0, MAX_DEVICE_SCAN_RESULTS);
}
