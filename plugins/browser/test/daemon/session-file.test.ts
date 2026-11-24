import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserSession } from "../../daemon/actions.js";
import { SessionFile } from "../../daemon/session-file.js";
import { systemClock } from "../../daemon/state.js";
import { removeDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

/** A session with fixed tabs; `navs` records the navigations restoreTabs starts. */
function fakeSession(opts: { slowNav?: Promise<void> } = {}) {
  const navs: string[] = [];
  let next = 1;
  const page = () => ({ id: `t${next++}` });
  const session = {
    tabs: () => [{ id: "t1", title: "A", url: "https://a.test/", active: true }],
    activePage: async () => page(),
    openTab: async () => page(),
    tabIdOf: (p: { id: string }) => p.id,
    viewerNav: async (n: { url: string }) => {
      navs.push(n.url);
      await opts.slowNav;
    },
    switchTo: async () => undefined,
  };
  return { session: session as unknown as BrowserSession, navs };
}

describe("daemon session file", () => {
  it("writes the handoff as it is when the queued write runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbd-sf-"));
    dirs.push(dir);
    const f = new SessionFile(dir, systemClock);
    let handoff: { callId: string; message: string } | undefined;
    const { session } = fakeSession();
    f.save(session, () => handoff);
    handoff = { callId: "h", message: "Sign in" };
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    const saved = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    expect(saved.handoff).toEqual({ callId: "h", message: "Sign in" });
  });

  it("starts the tabs' navigations without waiting for them to load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbd-sf-"));
    dirs.push(dir);
    const f = new SessionFile(dir, systemClock);
    const { session, navs } = fakeSession({ slowNav: new Promise(() => undefined) });
    await f.restoreTabs(session, {
      savedAt: Date.now(),
      tabs: ["https://a.test/", "https://b.test/"],
      active: 1,
    });
    expect(navs).toEqual(["https://a.test/", "https://b.test/"]);
  });
});
