import { describe, expect, it } from "vitest";
import { pastInterrupts, pastNetworkChanges } from "../../daemon/actions.js";

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

const URL_ = "http://127.0.0.1:4000/page";
const interrupted = (to: string) =>
  new Error(`page.goto: Navigation to "${URL_}" is interrupted by another navigation to "${to}"`);

describe("navigations past the late error page of the tab's previous navigation", () => {
  it("follows Chromium's own new run of the navigation after the error page interrupted it", async () => {
    // the error page commits under the first run, nothing goes on, the second run is
    // interrupted by Chromium starting the same address itself, and that one loads
    const runs: string[] = [];
    const follows = [{ kind: "none" as const }, { kind: "loaded" as const, response: "page" }];
    const out = await pastInterrupts(
      async () => {
        runs.push("run");
        throw interrupted(runs.length === 1 ? "chrome-error://chromewebdata/" : URL_);
      },
      async () => follows.shift() ?? { kind: "none" as const },
      URL_,
      3_000,
      () => 0,
    );
    expect(out).toBe("page");
    expect(runs).toEqual(["run", "run"]);
  });

  it("runs again after an abort until the deadline, then ends as a timeout", async () => {
    let t = 0;
    let runs = 0;
    const err = await pastInterrupts(
      async () => {
        runs++;
        t += 1_000;
        throw interrupted("chrome-error://chromewebdata/");
      },
      async () => ({ kind: "failed" as const, url: URL_, error: "net::ERR_ABORTED" }),
      URL_,
      3_000,
      () => t,
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe("TimeoutError");
    expect(runs).toBe(3);
  });

  it("passes an interrupt by another address through: that navigation is not this one", async () => {
    let runs = 0;
    const err = await pastInterrupts(
      async () => {
        runs++;
        throw interrupted("http://127.0.0.1:4000/other");
      },
      none,
      URL_,
      3_000,
      () => 0,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain('another navigation to "http://127.0.0.1:4000/other"');
    expect(runs).toBe(1);
  });

  it("reports the real failure of the navigation that went on", async () => {
    const err = await pastInterrupts(
      async () => {
        throw interrupted(URL_);
      },
      async () => ({ kind: "failed" as const, url: URL_, error: "net::ERR_CONNECTION_RESET" }),
      URL_,
      3_000,
      () => 0,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe(`net::ERR_CONNECTION_RESET at ${URL_}`);
  });
});
