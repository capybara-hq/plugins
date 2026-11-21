import { defineExtension } from "@capybara-hq/plugin-sdk";

// The manifest identity at the top level, where `capybara-plugin sync-versions` finds its version.
// capybara:allow-module-state read-only manifest constants, never mutated
const MANIFEST = Object.freeze({
  name: "google",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.50",
} as const);

/** Placeholder until the identity source lands (replaced in the same branch). */
export default defineExtension({
  ...MANIFEST,
  provides: [],
  permissions: {},
  setup() {},
});
