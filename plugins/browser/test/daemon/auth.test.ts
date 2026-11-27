// HTTP Basic auth (dialogs spec §4): a 401 Basic challenge becomes an auth dialog, the person
// signs in from the panel, and the credentials stay in the daemon's memory and go only where a
// browser's own page would send them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AUTH_SIGN_IN_TEXT,
  dialogQuote,
  type PendingDialogView,
  type ToolReply,
  type ViewerOut,
} from "../../daemon/protocol.js";
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

const USER = "ann";
const PASSWORD = "s3cret-Pa55-for-test";
const GOOD = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;

/** What the protected server saw: path and Authorization of every request. */
const seen: { path: string; auth: string | undefined; method: string }[] = [];
/** The site's password changed (the stored credentials no longer work). */
let rotated = false;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
let other: Awaited<ReturnType<typeof startFixtureServer>>;
const daemons: TestDaemon[] = [];

const guard =
  (body: string, scheme = 'Basic realm="Team area"') =>
  (req: IncomingMessage, res: import("node:http").ServerResponse) => {
    seen.push({
      path: new URL(req.url ?? "/", "http://x").pathname,
      auth: req.headers.authorization,
      method: req.method ?? "",
    });
    if (rotated || req.headers.authorization !== GOOD) {
      res.writeHead(401, { "www-authenticate": scheme, "content-type": "text/html" });
      res.end("<!doctype html><title>401</title><p>sign in needed</p>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  };

beforeAll(async () => {
  site = await startFixtureServer({
    "/secret": guard(
      `<!doctype html><title>Secret</title><p>the secret page</p><img src="/own.png"><a href="/next" id="n">next</a>`,
    ),
    "/next": guard("<!doctype html><title>Next</title><p>next page</p>"),
    "/own.png": guard(""),
    "/digest": guard("", 'Digest realm="x", nonce="1"'),
    "/x": guard(""),
    "/img": guard(""),
    "/fetch": guard(""),
    "/form": guard(""),
  });
  // another origin (another port): its page calls the signed-in site
  other = await startFixtureServer({
    "/cross": (_req, res) => {
      const at = (path: string) => JSON.stringify(`${site.url}${path}`);
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Cross</title>
<img src=${at("/img")}>
<form method="post" action=${at("/form")} id="f"></form>
<script>
  // (the full build never settles a fetch the site answers with a sign-in challenge)
  fetch(${at("/fetch")}, { credentials: "include", mode: "no-cors" }).catch(() => {});
  setTimeout(() => document.getElementById("f").submit(), 200);
</script>`);
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
  rotated = false;
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

/** Signs in from a viewer holding control, then hands back. */
async function signIn(d: TestDaemon, v: TestViewer, dialog: PendingDialogView): Promise<void> {
  v.send({ t: "takeover" });
  await v.next(stateWith((s) => s.control === "user"));
  v.send({ t: "dialog", id: dialog.id, action: "accept", username: USER, password: PASSWORD });
  await v.after(stateWith((s) => s.dialogs.length === 0));
  v.send({ t: "handback" });
  await v.after(stateWith((s) => s.control === "agent"));
  void d;
}

describe("HTTP Basic auth", () => {
  it("401 Basic raises an auth dialog; the agent may only dismiss it", async () => {
    const d = await daemon();
    const r = ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/secret` }));
    expect(r.dialog).toMatchObject({ kind: "auth", origin: site.url, realm: "Team area" });
    const dialog = r.dialog as PendingDialogView;
    // not blocking: the tab reads as usual (the headless shell shows the 401 body, the full
    // build an error page)
    ok(await request(d.socketPath, { op: "snapshot" }));
    const accept = await request(d.socketPath, {
      op: "dialog",
      dialogId: dialog.id,
      message: dialogQuote(dialog.message),
      action: "accept",
    });
    expect(accept).toMatchObject({ ok: false, message: AUTH_SIGN_IN_TEXT });
    const dismiss = ok(
      await request(d.socketPath, {
        op: "dialog",
        dialogId: dialog.id,
        message: dialogQuote(dialog.message),
        action: "dismiss",
      }),
    );
    expect(dismiss.dialog).toBeUndefined();
  });

  it("Digest is noted as unsupported", async () => {
    const d = await daemon();
    const r = ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/digest` }));
    expect(r.dialog).toBeUndefined();
    expect(r.text).toContain("The site asks for Digest sign-in, which the browser cannot do");
  });

  it("viewer credentials sign in and reload; the agent's next reply notes it; they never leave the daemon's memory", async () => {
    const d = await daemon();
    const r = ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/secret` }));
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
    // without control: refused
    v.send({
      t: "dialog",
      id: (r.dialog as PendingDialogView).id,
      action: "accept",
      username: USER,
      password: PASSWORD,
    });
    await signIn(d, v, r.dialog as PendingDialogView);
    const next = ok(
      await request(d.socketPath, { op: "wait", text: "the secret page", timeoutMs: 30_000 }),
    );
    expect(next.text).toContain(`The user signed in to ${site.url} (HTTP auth).`);
    // the page's own subresource and a same-origin navigation are signed
    ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/next` }));
    expect(seen.some((s) => s.path === "/own.png" && s.auth === GOOD)).toBe(true);
    expect(seen.some((s) => s.path === "/next" && s.auth === GOOD)).toBe(true);
    const replies = [JSON.stringify(r), JSON.stringify(next)];
    // the password is in no reply, viewer message or file of the daemon's state directory
    for (const text of [...replies, ...v.messages.map((m) => JSON.stringify(m))])
      expect(text).not.toContain(PASSWORD);
    for (const file of walk(d.stateDir)) {
      const bytes = readFileSync(file);
      expect(bytes.includes(PASSWORD), file).toBe(false);
      expect(bytes.includes(Buffer.from(`${USER}:${PASSWORD}`).toString("base64")), file).toBe(
        false,
      );
    }
    await v.close();
  });

  it("a cross-site page's requests to the signed-in origin carry no Authorization", async () => {
    const d = await daemon();
    const r = ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/secret` }));
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
    await signIn(d, v, r.dialog as PendingDialogView);
    ok(await request(d.socketPath, { op: "wait", text: "the secret page", timeoutMs: 30_000 }));
    seen.length = 0;
    // the other origin's page fetches (with credentials), loads an image and posts a form there
    ok(await request(d.socketPath, { op: "navigate", url: `${other.url}/cross` }));
    await expect.poll(() => seen.some((x) => x.path === "/form"), { timeout: 30_000 }).toBe(true);
    for (const path of ["/fetch", "/img", "/form"]) {
      const hit = seen.find((x) => x.path === path);
      expect(hit, path).toBeDefined();
      expect(hit?.auth, path).toBeUndefined();
    }
    // a 401 to a request the credentials never signed keeps them: the site still opens
    ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/secret` }));
    ok(await request(d.socketPath, { op: "wait", text: "the secret page", timeoutMs: 30_000 }));
    await v.close();
  });

  it("credentials go only to the exact origin; a new 401 clears them and asks again", async () => {
    const d = await daemon();
    const r = ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/secret` }));
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
    await signIn(d, v, r.dialog as PendingDialogView);
    ok(await request(d.socketPath, { op: "wait", text: "the secret page", timeoutMs: 30_000 }));
    // the same host on another port is another origin
    const sameHost = site.url.replace("127.0.0.1", "localhost");
    seen.length = 0;
    const again = ok(await request(d.socketPath, { op: "navigate", url: `${sameHost}/x` }));
    expect(seen.find((s) => s.path === "/x")?.auth).toBeUndefined();
    expect(again.dialog?.kind).toBe("auth");
    // the password changed: the signed request's 401 drops the credentials and asks again
    rotated = true;
    const asked = ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/next` }));
    expect(asked.dialog).toMatchObject({ kind: "auth", origin: site.url });
    rotated = false;
    seen.length = 0;
    ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/secret` }));
    expect(seen.find((s) => s.path === "/secret")?.auth).toBeUndefined();
    await v.close();
  });

  it("auth answer refused without control", async () => {
    const d = await daemon();
    const r = ok(await request(d.socketPath, { op: "navigate", url: `${site.url}/secret` }));
    const v = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 });
    await v.next(stateWith((s) => s.dialogs.length === 1));
    v.send({
      t: "dialog",
      id: (r.dialog as PendingDialogView).id,
      action: "accept",
      username: USER,
      password: PASSWORD,
    });
    const still = ok(await request(d.socketPath, { op: "tabs", action: "list" }));
    expect(still.dialog?.id).toBe((r.dialog as PendingDialogView).id);
    expect(seen.every((s) => s.auth === undefined)).toBe(true);
    await v.close();
  });
});

/** Every file under a directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}
