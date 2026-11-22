import {
  DeviceRequestNotSentError,
  isDeviceRequestNotSent,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import type { BindInstanceRequest } from "@capybara-hq/plugin-sdk/device-protocol";
import { describe, expect, it } from "vitest";
import {
  createInstanceBindings,
  InstanceBindingError,
  machineCall,
  nextGeneration,
} from "../src/index.js";
import {
  type Answer,
  fakeBinder,
  fakeDialIn,
  memoryStore,
  rejection,
  type SentRequest,
  signal,
} from "./fakes.js";

const DEVICE = "dev-1";

/** Bindings over a fake channel to a machine binding by the chain rules (or `answer`). */
function setup(answer?: (req: SentRequest, bind: () => Answer) => Answer | Promise<Answer>) {
  const binder = fakeBinder(DEVICE);
  const bind = (req: SentRequest) => () => binder.bind(req.args as unknown as BindInstanceRequest);
  const dial = fakeDialIn((req) => (answer ? answer(req, bind(req)) : bind(req)()));
  const { store, rows } = memoryStore();
  const clock = { now: 5_000 };
  const bindings = createInstanceBindings(machineCall(dial.channel), store, () => clock.now);
  return { bindings, binder, dial, store, rows, clock };
}

describe("generations", () => {
  it("never reuses a generation across a rolled-back clock", () => {
    expect(nextGeneration(null, 1000)).toBe("1000");
    expect(nextGeneration("1000", 2000)).toBe("2000");
    // the clock went back: one more than the previous
    expect(nextGeneration("2000", 1500)).toBe("2001");
  });

  it("gives creates within one millisecond consecutive generations", () => {
    expect(nextGeneration("1000", 1000)).toBe("1001");
    expect(nextGeneration("1001", 1000)).toBe("1002");
    // past the safe integer range too (generations are compared as integers)
    expect(nextGeneration("9007199254740993", 0)).toBe("9007199254740994");
  });

  it("refuses an unordered prior generation instead of guessing a high-water mark", () => {
    expect(() => nextGeneration("not-a-number", 1000)).toThrow();
  });
});

describe("binding a new generation", () => {
  it("commits the binding awaiting the device before it is sent and installs only the verified answer", async () => {
    const s = setup((req, bind) => {
      // while the machine binds, the committed binding attests nothing
      expect(s.rows.get(DEVICE)).toMatchObject({
        status: "awaiting-device",
        generation: (req.args as unknown as BindInstanceRequest).instanceGeneration,
      });
      expect(s.rows.get(DEVICE)?.installed).toBeUndefined();
      return bind();
    });
    const bound = await s.bindings.bindNew(DEVICE, signal());
    expect(bound).toMatchObject({
      deviceId: DEVICE,
      instanceId: DEVICE,
      generation: "5000",
      previousGeneration: null,
      status: "installed",
    });
    expect(bound.installed?.runtimeIdentity.instanceGeneration).toBe("5000");
    expect(s.rows.get(DEVICE)).toEqual(bound);
    expect(s.dial.sent).toHaveLength(1);
  });

  it("an awaiting binding stays unattested when the machine refuses or the answer is lost", async () => {
    const s = setup(() => ({
      ok: false,
      error: { kind: "unsupported", message: "update capybara-device" },
    }));
    await expect(s.bindings.bindNew(DEVICE, signal())).rejects.toThrow("update capybara-device");
    expect(s.rows.get(DEVICE)).toMatchObject({ status: "awaiting-device" });
    expect(s.rows.get(DEVICE)?.installed).toBeUndefined();
  });

  it("an answer for another generation or binding id is never installed", async () => {
    const s = setup((_req, bind) => {
      const a = bind() as { ok: true; result: Record<string, unknown> };
      return { ok: true, result: { ...a.result, bindingId: "another" } };
    });
    expect(await rejection(s.bindings.bindNew(DEVICE, signal()))).toBeInstanceOf(ToolError);
    expect(s.rows.get(DEVICE)?.status).toBe("awaiting-device");
    const t = setup((_req, bind) => {
      const a = bind() as { ok: true; result: { runtimeIdentity: Record<string, string> } };
      return {
        ok: true,
        result: {
          ...a.result,
          runtimeIdentity: { ...a.result.runtimeIdentity, instanceGeneration: "1" },
        },
      };
    });
    expect(await rejection(t.bindings.bindNew(DEVICE, signal()))).toBeInstanceOf(ToolError);
    expect(t.rows.get(DEVICE)?.status).toBe("awaiting-device");
  });

  it("a delayed answer for a replaced generation cannot populate the replacement", async () => {
    const release: { go?: () => void } = {};
    const s = setup(async (req, bind) => {
      // the machine binds at once; only its answer for the first generation is delayed
      const answer = bind();
      const gen = (req.args as unknown as BindInstanceRequest).instanceGeneration;
      if (gen === "5000") await new Promise<void>((r) => (release.go = r));
      return answer;
    });
    const old = s.bindings.bindNew(DEVICE, signal());
    while (!release.go) await new Promise((r) => setImmediate(r));
    // the instance is replaced while the old answer is on its way
    s.clock.now = 6_000;
    const replacement = await s.bindings.bindNew(DEVICE, signal());
    expect(replacement).toMatchObject({ generation: "6000", previousGeneration: "5000" });
    release.go();
    expect(await rejection(old)).toBeInstanceOf(InstanceBindingError);
    expect(s.rows.get(DEVICE)).toEqual(replacement);
  });

  it("two commits of one device allocate one binding; the other is refused", async () => {
    const s = setup();
    const { store } = s;
    // another commit lands between this one's read and its write
    const real = store.binding.bind(store);
    store.binding = async (deviceId) => {
      const b = await real(deviceId);
      await store.commitBinding(
        {
          deviceId,
          instanceId: deviceId,
          generation: "9000",
          bindingId: "other",
          previousGeneration: null,
          status: "awaiting-device",
        },
        null,
      );
      return b;
    };
    await expect(s.bindings.bindNew(DEVICE, signal())).rejects.toThrow("at the same time");
    expect(s.rows.get(DEVICE)?.bindingId).toBe("other");
    expect(s.dial.sent).toEqual([]);
  });

  it("a lost answer, then a replacement: the next binding follows what was sent", async () => {
    let lose = true;
    const s = setup((_req, bind) => {
      const answer = bind();
      if (lose) throw new Error("the answer was lost");
      return answer;
    });
    await expect(s.bindings.bindNew(DEVICE, signal())).rejects.toThrow("lost");
    // the machine stored 5000; the provider replaces the instance before ever installing it
    expect(s.binder.stored?.instanceGeneration).toBe("5000");
    lose = false;
    s.clock.now = 7_000;
    const next = await s.bindings.bindNew(DEVICE, signal());
    expect(next).toMatchObject({
      generation: "7000",
      previousGeneration: "5000",
      status: "installed",
    });
  });

  it("a re-login binds its first generation on a machine that kept the old credential's binding", async () => {
    const s = setup();
    await s.bindings.bindNew(DEVICE, signal());
    // the same device directory signed in again: the old binding is no previous of the new one
    s.binder.credential = "credential-2";
    s.clock.now = 8_000;
    expect(await s.bindings.bindNew(DEVICE, signal())).toMatchObject({ status: "installed" });
  });

  it("a machine whose stored binding is newer than the chain refuses the binding", async () => {
    const s = setup();
    s.binder.stored = {
      instanceId: DEVICE,
      instanceGeneration: "99999",
      bindingId: "elsewhere",
      expectedPreviousGeneration: null,
      credential: s.binder.credential,
      runtime: { ...s.binder.runtime },
    };
    await expect(s.bindings.bindNew(DEVICE, signal())).rejects.toThrow("older generation");
    expect(s.rows.get(DEVICE)?.status).toBe("awaiting-device");
  });
});

describe("re-verifying a bound generation", () => {
  it("re-sends the identical binding and installs an awaiting one", async () => {
    let lose = true;
    const s = setup((_req, bind) => {
      const answer = bind();
      if (lose) throw new Error("the answer was lost");
      return answer;
    });
    await expect(s.bindings.bindNew(DEVICE, signal())).rejects.toThrow("lost");
    const committed = s.rows.get(DEVICE);
    lose = false;
    expect(await s.bindings.rebind(DEVICE, "5000", signal())).toBe("bound");
    expect(s.dial.sent.map((r) => r.args)).toEqual([
      s.dial.sent[0]?.args,
      {
        instanceId: DEVICE,
        instanceGeneration: "5000",
        bindingId: committed?.bindingId,
        expectedPreviousGeneration: null,
      },
    ]);
    expect(s.rows.get(DEVICE)).toMatchObject({
      status: "installed",
      bindingId: committed?.bindingId,
    });
  });

  it("the runtime-hash re-probe: a changed runtime is gone, and the rebuilt instance binds anew", async () => {
    const s = setup();
    await s.bindings.bindNew(DEVICE, signal());
    expect(await s.bindings.rebind(DEVICE, "5000", signal())).toBe("bound");
    // capybara-device restarted with another runtime: it refuses the old generation's identity
    s.binder.runtime = { ...s.binder.runtime, runtimeHash: "e".repeat(64) };
    expect(await s.bindings.rebind(DEVICE, "5000", signal())).toBe("gone");
    s.clock.now = 9_000;
    const next = await s.bindings.bindNew(DEVICE, signal());
    expect(next.installed?.runtimeIdentity.runtimeHash).toBe("e".repeat(64));
    expect(await s.bindings.rebind(DEVICE, "9000", signal())).toBe("bound");
  });

  it("an installed generation re-attested under another runtime is gone, whatever the machine says", async () => {
    let helper: string | undefined;
    const s = setup((_req, bind) => {
      const a = bind() as { ok: true; result: { runtimeIdentity: Record<string, string> } };
      return helper === undefined
        ? a
        : {
            ok: true,
            result: {
              ...a.result,
              runtimeIdentity: { ...a.result.runtimeIdentity, helperHash: helper },
            },
          };
    });
    const bound = await s.bindings.bindNew(DEVICE, signal());
    helper = "f".repeat(64);
    expect(await s.bindings.rebind(DEVICE, "5000", signal())).toBe("gone");
    expect(s.rows.get(DEVICE)).toEqual(bound);
  });

  it("another generation than the device's binding is gone without asking the machine", async () => {
    const s = setup();
    expect(await s.bindings.rebind(DEVICE, "5000", signal())).toBe("gone");
    await s.bindings.bindNew(DEVICE, signal());
    expect(await s.bindings.rebind(DEVICE, "4999", signal())).toBe("gone");
    expect(s.dial.sent).toHaveLength(1);
  });

  it("a request that was never sent stays an error to retry", async () => {
    let notSent = false;
    const s = setup((_req, bind) => {
      if (notSent) throw new DeviceRequestNotSentError("connection changed");
      return bind();
    });
    await s.bindings.bindNew(DEVICE, signal());
    notSent = true;
    expect(
      isDeviceRequestNotSent(await rejection(s.bindings.rebind(DEVICE, "5000", signal()))),
    ).toBe(true);
  });
});
