import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViewerOut } from "../../daemon/protocol.js";
import {
  openViewer,
  removeDir,
  request,
  startTestDaemon,
  type TestDaemon,
  type ViewerMsg,
} from "./helpers.js";

type State = Extract<ViewerOut, { t: "state" }>;
const isState = (m: ViewerMsg): m is State => m.t === "state";

let d: TestDaemon;

beforeAll(async () => {
  d = await startTestDaemon();
});

afterAll(async () => {
  await d?.stop();
  if (d) removeDir(d.stateDir);
});

/** The ids of the daemon's tabs, from the tab list. */
async function tabIds(): Promise<string[]> {
  const r = await request(d.socketPath, { op: "tabs", action: "list" });
  if (!r.ok) throw new Error(r.message);
  return (r.text ?? "")
    .split("\n")
    .map((l) => /^(t\d+)/.exec(l)?.[1])
    .filter((id): id is string => id !== undefined);
}

/** Opens tabs until there are exactly two; their ids. */
async function twoTabs(): Promise<[string, string]> {
  await request(d.socketPath, { op: "tabs", action: "open" });
  let ids = await tabIds();
  for (const id of ids.slice(0, -2)) {
    await request(d.socketPath, { op: "tabs", action: "close", tabId: id });
  }
  ids = await tabIds();
  const [a, b] = ids;
  if (ids.length !== 2 || a === undefined || b === undefined)
    throw new Error(`expected two tabs, got ${ids.join(", ")}`);
  return [a, b];
}

describe("closing the last tabs", () => {
  it("two quick closes by the agent leave one blank tab", async () => {
    const [a, b] = await twoTabs();
    const replies = await Promise.all([
      request(d.socketPath, { op: "tabs", action: "close", tabId: a }),
      request(d.socketPath, { op: "tabs", action: "close", tabId: b }),
      request(d.socketPath, { op: "tabs", action: "list" }),
    ]);
    for (const r of replies) expect(r).toMatchObject({ ok: true });
    expect(await tabIds()).toHaveLength(1);
  });

  it("two quick closes by the person leave one blank tab", async () => {
    const [a, b] = await twoTabs();
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next(isState);
    const taken = v.after((m) => isState(m) && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    const one = v.after(
      (m) => isState(m) && m.tabs.length === 1 && m.tabs[0]?.id !== a && m.tabs[0]?.id !== b,
    );
    v.send({ t: "tab", action: "close", tabId: a });
    v.send({ t: "tab", action: "close", tabId: b });
    await one;
    const back = v.after((m) => isState(m) && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    expect(await tabIds()).toHaveLength(1);
    await v.close();
  });
});
