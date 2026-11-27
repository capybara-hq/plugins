// A page's own requests to an HTTP Basic resource (plugins#292): a subresource, fetch() or XHR
// answered 401 with a Basic challenge settles promptly with the 401 for the page's own handling,
// signed only when the person signed in to that exact origin and the page is that origin's.
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PendingDialogView, ToolReply, ViewerOut } from "../../daemon/protocol.js";
import {
  openViewer,
  removeDir,
  request,
  startFixtureServer,
  startTestDaemon,
  type TestDaemon,
  type TestViewer,
  type ViewerMsg,
} from "./helpers.js";

const USER = "bob";
const PASSWORD = "an0ther-Pa55-for-test";
const GOOD = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;

/** What the protected server saw: path and Authorization of every request. */
const seen: { path: string; auth: string | undefined }[] = [];
let site: Awaited<ReturnType<typeof startFixtureServer>>;
let other: Awaited<ReturnType<typeof startFixtureServer>>;
const daemons: TestDaemon[] = [];

const guard =
  (body: string, type = "text/html") =>
  (req: IncomingMessage, res: ServerResponse) => {
    seen.push({
      path: new URL(req.url ?? "/", "http://x").pathname,
      auth: req.headers.authorization,
    });
    if (req.headers.authorization !== GOOD) {
      res.writeHead(401, {
        "www-authenticate": 'Basic realm="Data"',
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
      });
      res.end("sign in needed");
      return;
    }
    res.writeHead(200, { "content-type": type, "access-control-allow-origin": "*" }).end(body);
  };

/**
 * A page that calls `base` with fetch() and XHR and loads an image from it, and writes each
 * outcome into the page (`fetch 401`, `xhr 401`, `img error`) so the agent can wait for it.
 */
const caller = (base: string) => `<!doctype html><title>Caller</title>
<p id="out">started</p>
<script>
  const out = (s) => { const p = document.createElement("p"); p.textContent = s; document.body.append(p); };
  fetch(${JSON.stringify(`${base}/data`)}).then((r) => out("fetch " + r.status), (e) => out("fetch failed"));
  const x = new XMLHttpRequest();
  x.open("GET", ${JSON.stringify(`${base}/xhr`)});
  x.onload = () => out("xhr " + x.status);
  x.onerror = () => out("xhr failed");
  x.send();
  const i = new Image();
  i.onload = () => out("img loaded");
  i.onerror = () => out("img error");
  i.src = ${JSON.stringify(`${base}/pic`)};
</script>`;

beforeAll(async () => {
  site = await startFixtureServer({
    "/secret": guard("<!doctype html><title>Secret</title><p>the secret page</p>"),
    "/data": guard("the data", "text/plain"),
    "/xhr": guard("the xhr", "text/plain"),
    "/pic": guard("", "image/png"),
    "/caller": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end(caller(""));
    },
  });
  other = await startFixtureServer({
    "/caller": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end(caller(site.url));
    },
  });
});

afterAll(async () => {
  await site?.close();
  await other?.close();
});

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.stop();
    removeDir(d.stateDir);
  }
  seen.length = 0;
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

type State = Extract<ViewerOut, { t: "state" }>;
const stateWith = (pred: (s: State) => boolean) => (m: ViewerMsg) => m.t === "state" && pred(m);

/** Signs in to the site from a viewer holding control, then hands back. */
async function signIn(d: TestDaemon): Promise<TestViewer> {
  const r = ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/secret` }));
  const dialog = r.dialog as PendingDialogView;
  expect(dialog).toMatchObject({ kind: "auth", origin: site.url });
  const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
  v.send({ t: "takeover" });
  await v.next(stateWith((s) => s.control === "user"));
  v.send({ t: "dialog", id: dialog.id, action: "accept", username: USER, password: PASSWORD });
  await v.after(stateWith((s) => s.dialogs.length === 0));
  v.send({ t: "handback" });
  await v.after(stateWith((s) => s.control === "agent"));
  ok(await request(d.socketPath, { op: "wait", text: "the secret page", timeoutMs: 10_000 }));
  seen.length = 0;
  return v;
}

/** Waits (within the normal action time) for every outcome line of the caller page. */
async function outcomes(d: TestDaemon, lines: string[]): Promise<void> {
  for (const text of lines)
    ok(await request(d.socketPath, { op: "wait", text, timeoutMs: 10_000 }));
  // the page is still usable: an ordinary action replies
  ok(await request(d.socketPath, { op: "snapshot" }));
}

describe("a page's own requests to an HTTP Basic resource", () => {
  it("same origin, not signed in: fetch, XHR and image settle with the 401; no dialog", async () => {
    const d = await daemon();
    const r = ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/caller` }));
    expect(r.dialog).toBeUndefined();
    await outcomes(d, ["fetch 401", "xhr 401", "img error"]);
    const tabs = ok(await request(d.socketPath, { op: "tabs", action: "list" }));
    expect(tabs.dialog).toBeUndefined();
    expect(seen.every((s) => s.auth === undefined)).toBe(true);
  });

  it("other origin, not signed in: fetch, XHR and image settle with the 401; no dialog", async () => {
    const d = await daemon();
    const r = ok(await request(d.socketPath, { op: "navigate", url: `${other.url}/caller` }));
    expect(r.dialog).toBeUndefined();
    await outcomes(d, ["fetch 401", "xhr 401", "img error"]);
    expect(seen.every((s) => s.auth === undefined)).toBe(true);
  });

  it("same origin, signed in: the page's requests are signed and succeed", async () => {
    const d = await daemon();
    const v = await signIn(d);
    ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/caller` }));
    await outcomes(d, ["fetch 200", "xhr 200"]);
    for (const path of ["/data", "/xhr", "/pic"])
      expect(seen.find((s) => s.path === path)?.auth, path).toBe(GOOD);
    await v.close();
  });

  it("other origin, signed in: no credentials cross over; the requests settle with the 401", async () => {
    const d = await daemon();
    const v = await signIn(d);
    ok(await request(d.socketPath, { op: "navigate", url: `${other.url}/caller` }));
    await outcomes(d, ["fetch 401", "xhr 401", "img error"]);
    for (const path of ["/data", "/xhr", "/pic"]) {
      const hit = seen.find((s) => s.path === path);
      expect(hit, path).toBeDefined();
      expect(hit?.auth, path).toBeUndefined();
    }
    // the unsigned 401s kept the credentials: the site still opens
    ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/secret` }));
    ok(await request(d.socketPath, { op: "wait", text: "the secret page", timeoutMs: 10_000 }));
    await v.close();
  });
});
