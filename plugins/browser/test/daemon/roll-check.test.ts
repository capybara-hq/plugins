import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLL_CHECK_REQUEST, type ToolRequest } from "../../daemon/protocol.js";
import { openViewer, removeDir, request, startTestDaemon, type TestDaemon } from "./helpers.js";

let d: TestDaemon;

beforeAll(async () => {
  d = await startTestDaemon();
});

afterAll(async () => {
  await d?.stop();
  if (d) removeDir(d.stateDir);
});

/** The kernel's roll check (SDK `DEVICE_SERVICE_ROLL_CHECK`), answered like a request. */
const rollCheck = () =>
  request(d.socketPath, JSON.parse(ROLL_CHECK_REQUEST) as ToolRequest) as Promise<unknown>;

describe("roll check", () => {
  it("is not busy while the agent has the browser and no handoff waits", async () => {
    expect(await rollCheck()).toEqual({ busy: false });
  });

  it("is busy while a handoff waits, and while the person holds control", async () => {
    await request(d.socketPath, { op: "handoff_notice", callId: "h1", message: "Sign in" });
    expect(await rollCheck()).toMatchObject({
      busy: true,
      reason: expect.stringMatching(/handoff/),
    });
    await request(d.socketPath, { op: "handoff_clear", callId: "h1" });
    expect(await rollCheck()).toEqual({ busy: false });
    const v = await openViewer(d.socketPath, { maxWidth: 480, maxHeight: 300 });
    await v.next((m) => m.t === "state");
    const taken = v.after((m) => m.t === "state" && m.control === "user");
    v.send({ t: "takeover" });
    await taken;
    expect(await rollCheck()).toMatchObject({
      busy: true,
      reason: expect.stringMatching(/control/),
    });
    const back = v.after((m) => m.t === "state" && m.control === "agent");
    v.send({ t: "handback" });
    await back;
    expect(await rollCheck()).toEqual({ busy: false });
    await v.close();
  });
});
