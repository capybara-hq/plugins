import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";

// TEMPORARY: remove once @capybara-hq/testing's dual-replica children load TypeScript plugins
// themselves (that fix is in progress in capybara-hq/core).
//
// Dual-replica tests (@capybara-hq/testing's createDualReplicaHarness) start each kernel replica as
// a plain `node` child process that inherits process.env. tsx lets that child load the plugin under
// test from src (mapping ./x.js to ./x.ts) and the TypeScript fake extensions @capybara-hq/testing
// ships under node_modules, which Node's own type stripping refuses.
//
// This runs inside the test worker, so it changes only the environment of the processes a test
// spawns afterwards, never the worker itself, and only in `*.dual.test.ts` files: other tests that
// spawn `node` (tools/ci's CLI test, for one) run it plain. The loader is an absolute file URL
// resolved from the repository root, so a child with another cwd still finds it.
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const flag = `--import=${tsxLoader}`;

const testPath = expect.getState().testPath ?? "";
const others = (process.env.NODE_OPTIONS ?? "")
  .split(" ")
  .filter((o) => o !== "" && o !== flag)
  .join(" ");
const next = testPath.endsWith(".dual.test.ts") ? `${others} ${flag}`.trim() : others;
if (next === "") delete process.env.NODE_OPTIONS;
else process.env.NODE_OPTIONS = next;
