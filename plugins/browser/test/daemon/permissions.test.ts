// Permission requests (dialogs spec §6): a refused request is reported to the page's owner and
// its tree's viewers; the person may allow notifications and clipboard reading; the report's
// payload is untrusted.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_PERMISSION_PAIRS } from "../../daemon/actions.js";
import { PERMISSION_REPORTS_PER_LOAD } from "../../daemon/permissions.js";
import type { ToolReply, ViewerOut } from "../../daemon/protocol.js";
import {
  conv,
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
  type ViewerMsg,
} from "./helpers.js";

/** The page's own binding call (any page can find it: the daemon trusts only the name). */
const FORGE = `const name = Object.keys(window).find((k) => k.startsWith("__cbPermission_"));`;

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
const daemons: TestDaemon[] = [];

beforeAll(async () => {
  fx = await startFixtureServer({
    "/notify": `<!doctype html><title>N</title><p id="out">wait</p><script>
      Notification.requestPermission().then((r) => { document.getElementById("out").textContent = "result:" + r; });
    </script>`,
    "/geo": `<!doctype html><title>G</title><p id="out">wait</p><script>
      navigator.geolocation.getCurrentPosition(() => {}, (e) => { document.getElementById("out").textContent = "geo:" + e.code; });
    </script>`,
    "/clip": `<!doctype html><title>C</title><p id="out">wait</p><script>
      navigator.clipboard.readText().then((t) => { document.getElementById("out").textContent = "clip:ok"; },
        (e) => { document.getElementById("out").textContent = "clip:" + e.name; });
    </script>`,
    "/native": `<!doctype html><title>T</title><p id="out"></p><script>
      document.getElementById("out").textContent = [Notification.requestPermission, Function.prototype.toString]
        .map((f) => String(f.toString().includes("[native code]"))).join(",") + ":" + Notification.requestPermission.name;
    </script>`,
    "/forge": `<!doctype html><title>F</title><p id="out">wait</p><script>
      ${FORGE}
      window[name]("bogus");
      window[name]({ toString() { return "notifications"; } });
      window[name]("camera", "https://evil.example");
      document.getElementById("out").textContent = "forged";
    </script>`,
    "/flood": `<!doctype html><title>F</title><p id="out">wait</p><script>
      ${FORGE}
      for (let i = 0; i < 20; i++) window[name](i % 2 ? "camera" : "microphone");
      document.getElementById("out").textContent = "flooded";
    </script>`,
  });
});

afterAll(async () => {
  await fx?.close();
});

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.stop();
    removeDir(d.stateDir);
  }
});

async function daemon(): Promise<TestDaemon> {
  const d = await startTestDaemon();
  daemons.push(d);
  return d;
}

const ok = (r: ToolReply) => {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
};

/** Opens a page and waits until its script wrote a result other than "wait". */
async function visit(d: TestDaemon, path: string, done: string, of = conv("c1")) {
  const nav = ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}${path}` }, of));
  const wait = ok(await request(d.socketPath, { op: "wait", text: done, timeoutMs: 30_000 }, of));
  // the notes of both replies (a report may ride either)
  return { ...wait, text: [nav.text, wait.text].filter((t) => t !== undefined).join("\n") };
}

type State = Extract<ViewerOut, { t: "state" }>;
const stateWith = (pred: (s: State) => boolean) => (m: ViewerMsg) => m.t === "state" && pred(m);
const isPermission = (m: ViewerMsg): m is Extract<ViewerOut, { t: "permission" }> =>
  m.t === "permission";

describe("permission requests", () => {
  it("a notifications denial is reported once to the owner and offered to the tree's viewers; a grant with control takes effect", async () => {
    const d = await daemon();
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
    const stranger = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 }, conv("c9"));
    const seen = await visit(d, "/notify", "result:");
    // the report reaches the daemon beside the page's own answer: the note rides the reply in
    // flight or the next one
    await v.next(isPermission);
    const first = `${seen.text}\n${ok(await request(d.socketPath, { op: "tabs", action: "list" })).text}`;
    expect(first).toContain(
      "The page asked for notifications permission, which was denied. The user can allow it from the browser panel.",
    );
    const strip = await v.next(isPermission);
    expect(strip).toMatchObject({ origin: fx.url, permission: "notifications", grantable: true });
    // reported once per origin and permission
    const again = await visit(d, "/notify", "result:");
    expect(again.text ?? "").not.toContain("notifications permission");
    // a viewer of another tree never sees it
    expect(stranger.messages.some(isPermission)).toBe(false);
    // without control: refused
    v.send({ t: "permission", origin: fx.url, permission: "notifications", allow: true });
    // another tree's viewer in control: refused (no pair recorded on its tree's tabs)
    stranger.send({ t: "takeover" });
    await stranger.next(stateWith((s) => s.control === "user"));
    stranger.send({ t: "permission", origin: fx.url, permission: "notifications", allow: true });
    stranger.send({ t: "handback" });
    await v.after(stateWith((s) => s.control === "agent"));
    const still = await visit(d, "/notify", "result:");
    expect(still.text ?? "").not.toContain("result:granted");
    const snap = ok(await request(d.socketPath, { op: "snapshot" }));
    expect(snap.text).not.toContain("result:granted");
    // the owner's viewer with control: granted for the daemon's life
    v.send({ t: "takeover" });
    await v.after(stateWith((s) => s.control === "user"));
    v.send({ t: "permission", origin: fx.url, permission: "notifications", allow: true });
    v.send({ t: "handback" });
    await v.after(stateWith((s) => s.control === "agent"));
    await visit(d, "/notify", "result:granted");
    await v.close();
    await stranger.close();
  });

  it("geolocation denial is reported as unavailable; clipboard is grantable; the page gets the same result", async () => {
    const d = await daemon();
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
    const geoReply = await visit(d, "/geo", "geo:");
    await v.next((m) => isPermission(m) && m.permission === "geolocation");
    const geo = `${geoReply.text}\n${ok(await request(d.socketPath, { op: "tabs", action: "list" })).text}`;
    expect(geo).toContain(
      "The page asked for geolocation permission, which was denied. The device's browser cannot provide it.",
    );
    expect(ok(await request(d.socketPath, { op: "snapshot" })).text).toContain("geo:1");
    const clipReply = await visit(d, "/clip", "clip:");
    const clipSnap = ok(await request(d.socketPath, { op: "snapshot" }));
    expect(clipSnap.text).toContain("clip:NotAllowedError");
    await v.next((m) => isPermission(m) && m.permission === "clipboard-read");
    const clip = [
      clipReply.text,
      clipSnap.text,
      ok(await request(d.socketPath, { op: "tabs", action: "list" })).text,
    ].join("\n");
    expect(clip).toContain("clipboard-read permission, which was denied. The user can allow");
    await v.close();
  });

  it("wrapped functions keep a native toString", async () => {
    const d = await daemon();
    await visit(d, "/native", "true");
    expect(ok(await request(d.socketPath, { op: "snapshot" })).text).toContain(
      "true,true:requestPermission",
    );
  });

  it("a forged origin is ignored and an unknown permission dropped; reports are capped per page", async () => {
    const d = await daemon();
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
    const forged = await visit(d, "/forge", "forged");
    await v.next(isPermission);
    const strips = v.messages.filter(isPermission);
    // only the camera report counts, with the page's own origin
    expect(strips).toEqual([
      { t: "permission", origin: fx.url, permission: "camera", grantable: false },
    ]);
    expect(forged.text ?? "").not.toContain("evil.example");
    await visit(d, "/flood", "flooded");
    // the flood page's reports: at most the cap per page load
    const after = v.messages.filter(isPermission).length - strips.length;
    expect(after).toBeLessThanOrEqual(PERMISSION_REPORTS_PER_LOAD);
    expect(MAX_PERMISSION_PAIRS).toBe(50);
    await v.close();
  });
});
