import { describe, expect, it } from "vitest";
import { findUpstream, parseRemoteConfig } from "../src/remotes.ts";

describe("findUpstream", () => {
  it("origin pointing to capybara-hq/plugins is not a fork", () => {
    expect(
      findUpstream(
        [{ name: "origin", url: "https://github.com/capybara-hq/plugins.git" }],
        "plugins",
      ),
    ).toEqual({
      remote: "origin",
      fork: false,
    });
  });

  it("upstream pointing to capybara-hq/plugins via SSH is a fork", () => {
    const remotes = [
      { name: "origin", url: "https://github.com/someone/plugins.git" },
      { name: "upstream", url: "git@github.com:Capybara-HQ/plugins" },
    ];
    expect(findUpstream(remotes, "plugins")).toEqual({ remote: "upstream", fork: true });
  });

  it("ssh:// URLs match, case-insensitively", () => {
    expect(
      findUpstream(
        [{ name: "up", url: "ssh://git@github.com/Capybara-HQ/plugins.git" }],
        "plugins",
      ),
    ).toEqual({ remote: "up", fork: true });
  });

  it("HTTPS URLs with embedded user info match", () => {
    const remotes = [
      { name: "origin", url: "https://grant-chao@github.com/capybara-hq/plugins.git" },
    ];
    expect(findUpstream(remotes, "plugins")).toEqual({ remote: "origin", fork: false });
  });

  it("no match returns null", () => {
    expect(
      findUpstream([{ name: "origin", url: "https://github.com/someone/plugins.git" }], "plugins"),
    ).toBeNull();
    expect(
      findUpstream(
        [{ name: "origin", url: "https://github.com/capybara-hq/plugins-extra.git" }],
        "plugins",
      ),
    ).toBeNull();
  });
});

describe("parseRemoteConfig", () => {
  it("handles dotted remote names", () => {
    expect(parseRemoteConfig("remote.my.fork.url git@github.com:me/plugins.git\n")).toEqual([
      { name: "my.fork", url: "git@github.com:me/plugins.git" },
    ]);
  });

  it("keeps the first url of a remote with several", () => {
    expect(
      parseRemoteConfig("remote.origin.url a\nremote.origin.url b\nremote.up.url c\n"),
    ).toEqual([
      { name: "origin", url: "a" },
      { name: "up", url: "c" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseRemoteConfig("")).toEqual([]);
  });
});
