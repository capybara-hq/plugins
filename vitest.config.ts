import { defineConfig } from "vitest/config";

// The "@capybara-hq/source" condition points a plugin's own exports at src, so tests run the
// source, not a possibly stale dist. The rest are Vite's default server conditions (setting
// conditions replaces the defaults, so they are all listed).
const conditions = ["@capybara-hq/source", "module", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  // No "module" on the server (tests): vitest passes the ssr conditions to the workers as Node's
  // --conditions, and with "module" the externalized dependencies Node loads natively would resolve
  // to "module" esm builds with extensionless imports (@aws-sdk/*, @opentelemetry/api) and fail.
  ssr: { resolve: { conditions: conditions.filter((c) => c !== "module") } },
  test: {
    hookTimeout: 120_000,
    // CI runners are loaded: dual-replica tests that start child processes time out near the 5s
    // default there (not a regression), so CI gets more.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["{plugins,tools}/*/test/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          // One PostgreSQL + one Valkey per run, handed to workers via env vars: startTestPostgres()
          // creates a database per file on it. CAPYBARA_TEST_NO_SHARED=1 restores per-file containers.
          globalSetup: ["@capybara-hq/testing/global-setup"],
          // The kernel comes from npm and loads the plugin under test with import() of
          // plugins/<name>/src/index.ts (imports written ./x.js). Vitest externalizes node_modules,
          // so that import would run in plain Node, which does not map ./x.js to ./x.ts. Inlining the
          // core packages lets Vite transform them and the dynamic import. The pattern is matched
          // against the resolved file path, not the package name (plugin-tools README).
          server: { deps: { inline: [/\/node_modules\/@capybara-hq\//] } },
          // TEMPORARY (until @capybara-hq/testing's dual-replica children load TypeScript plugins
          // themselves, a fix in capybara-hq/core): the setup file adds tsx to NODE_OPTIONS for the
          // child processes spawned by `*.dual.test.ts` files only. Not `test.env`: vitest builds the
          // fork workers' own environment from it, so every worker and every process any test spawns
          // would load tsx, resolved from that process's cwd.
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
