import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = readFileSync(new URL("../app-manifest.yaml", import.meta.url), "utf8");
const listUnder = (key: string) => {
  const m = new RegExp(`\\n(\\s*)${key}:\\n((?:\\1\\s+- .*\\n)+)`).exec(manifest);
  return (m?.[2] ?? "")
    .split("\n")
    .map((l) =>
      l
        .replace(/#.*$/, "")
        .replace(/^\s*-\s*/, "")
        .trim(),
    )
    .filter(Boolean);
};

describe("app-manifest.yaml", () => {
  it("turns on Socket Mode and interactivity", () => {
    expect(manifest).toMatch(/\n\s+socket_mode_enabled: true\n/);
    expect(manifest).toMatch(/\n\s+interactivity:\n\s+is_enabled: true\n/);
    expect(manifest).not.toMatch(/request_url/);
  });

  it("requests the bot scopes the plugin needs (plus users:read.email for the directory)", () => {
    expect(listUnder("bot").sort()).toEqual(
      [
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "groups:history",
        "im:history",
        "users:read",
        "users:read.email",
      ].sort(),
    );
  });

  it("subscribes to the events the plugin handles", () => {
    expect(listUnder("bot_events").sort()).toEqual(
      [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "team_join",
        "user_change",
      ].sort(),
    );
  });
});
