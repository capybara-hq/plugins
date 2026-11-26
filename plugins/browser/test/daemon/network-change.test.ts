import { describe, expect, it } from "vitest";
import { pastNetworkChanges } from "../../daemon/actions.js";

const changed = () => new Error("page.goto: net::ERR_NETWORK_CHANGED at https://a.test/");
const none = async () => ({ kind: "none" as const });

/** A clock starting at 0 that the runs move on: each run takes `step` ms. */
function clock(step: number) {
  let t = 0;
  return {
    now: () => t,
    tick: () => {
      t += step;
    },
  };
}

describe("navigations past changes of the device's network", () => {
  it("runs again at every change within the deadline, however many (a container start adds several)", async () => {
    const c = clock(100);
    let runs = 0;
    const out = await pastNetworkChanges(
      async () => {
        c.tick();
        if (++runs < 8) throw changed();
        return "page";
      },
      none,
      3_000,
      c.now,
    );
    expect(out).toBe("page");
    expect(runs).toBe(8);
  });

  it("ends as a timeout, not the last change's error, when the changes outlast the deadline", async () => {
    const c = clock(700);
    let runs = 0;
    const err = await pastNetworkChanges(
      async () => {
        runs++;
        c.tick();
        throw changed();
      },
      none,
      3_000,
      c.now,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("TimeoutError");
    // runs at 0, 700, 1400, 2100, 2800 ms; the fifth ends past the deadline
    expect(runs).toBe(5);
  });

  it("follows the navigation Chromium kept or restarted instead of starting another", async () => {
    let runs = 0;
    const out = await pastNetworkChanges(
      async () => {
        runs++;
        throw changed();
      },
      async () => ({ kind: "loaded" as const, response: "kept" }),
      3_000,
      () => 0,
    );
    expect(out).toBe("kept");
    expect(runs).toBe(1);
  });

  it("reports the real failure of the navigation that went on, and never runs an abort again", async () => {
    let runs = 0;
    const err = await pastNetworkChanges(
      async () => {
        runs++;
        throw changed();
      },
      async () => ({
        kind: "failed" as const,
        url: "https://a.test/",
        error: "net::ERR_CONNECTION_REFUSED",
      }),
      3_000,
      () => 0,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe("net::ERR_CONNECTION_REFUSED at https://a.test/");
    expect(runs).toBe(1);
  });

  it("passes any other error through at once", async () => {
    let runs = 0;
    const err = await pastNetworkChanges(
      async () => {
        runs++;
        throw new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://a.test/");
      },
      none,
      3_000,
      () => 0,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain("ERR_NAME_NOT_RESOLVED");
    expect(runs).toBe(1);
  });
});
