// Page dialogs held until answered (dialogs spec §3, §5): the opening request replies at once, the
// blocked tab refuses actions, browser_dialog answers exactly the dialog it names, and dialogs
// follow tab ownership.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DIALOG_CHANGED_MESSAGE,
  NO_DIALOG_MESSAGE,
  notYourTab,
  PAUSED_BY_DIALOG_MESSAGE,
  tabInUse,
} from "../../daemon/actions.js";
import { chromiumBuild } from "../../daemon/chromium.js";
import {
  CONVERSATION_IDLE_MS,
  DIALOG_QUOTE_CHARS,
  dialogQuote,
  type PendingDialogView,
  type ToolReply,
  type ViewerOut,
} from "../../daemon/protocol.js";
import {
  conv,
  openViewer,
  removeDir,
  request,
  ShiftClock,
  startFixtureServer,
  startTestDaemon,
  TEST_ENV,
  type TestDaemon,
  type ViewerMsg,
} from "./helpers.js";

const BUTTON = (onclick: string, label = "Go") =>
  `<!doctype html><title>D</title><style>body{margin:0}</style>
<button id="b" style="position:absolute;left:0;top:0;width:200px;height:60px" onclick="${onclick}">${label}</button>
<p id="out"></p>`;

const LONG = `${'Line one\r\n  with   spaces "quoted" '.repeat(10)}${"x".repeat(DIALOG_QUOTE_CHARS - 1)}😀 tail`;

/**
 * The macOS headless shell runs as one process: a held dialog stops every page there, so the
 * tests of other tabs acting meanwhile run on the full build (Linux, CI) and the one-process
 * refusal is tested where it applies.
 */
const SINGLE_PROCESS = chromiumBuild(process.platform, TEST_ENV) === "chromium-headless-shell";

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
const daemons: TestDaemon[] = [];

beforeAll(async () => {
  fx = await startFixtureServer({
    "/confirm": BUTTON(
      "document.getElementById('out').textContent = confirm('Delete this draft?') ? 'yes' : 'no'",
      "Delete",
    ),
    "/prompt": BUTTON(
      "document.getElementById('out').textContent = 'got:' + prompt('Your name?', 'Ann')",
    ),
    "/alert": BUTTON("alert('Saved'); document.getElementById('out').textContent = 'after'"),
    "/long": BUTTON(`confirm(${JSON.stringify(LONG).replace(/"/g, "&quot;")})`),
    "/leave": `<!doctype html><title>Leave</title><input id="i">
<script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script>`,
    "/plain": "<!doctype html><title>Plain</title><p>plain page</p>",
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

async function daemon(clock?: ShiftClock): Promise<TestDaemon> {
  const d = await startTestDaemon(clock === undefined ? {} : { clock });
  daemons.push(d);
  return d;
}

const ok = (r: ToolReply) => {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
};

/** Opens the page and clicks the button (ref of the only button: from a snapshot). */
async function openAndClick(d: TestDaemon, path: string, of = conv("c1")) {
  ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}${path}` }, of));
  const snap = ok(await request(d.socketPath, { op: "snapshot" }, of));
  const ref = /button "[^"]*" \[ref=((?:f\d+)?e\d+)\]/.exec(snap.text ?? "")?.[1];
  if (ref === undefined) throw new Error(`no button in ${snap.text}`);
  return request(d.socketPath, { op: "click", ref }, of);
}

const answer = (
  d: TestDaemon,
  dialog: PendingDialogView,
  action: "accept" | "dismiss",
  extra: { text?: string; message?: string } = {},
  of = conv("c1"),
) =>
  request(
    d.socketPath,
    {
      op: "dialog",
      dialogId: dialog.id,
      message: extra.message ?? dialogQuote(dialog.message),
      action,
      ...(extra.text === undefined ? {} : { text: extra.text }),
    },
    of,
  );

const outText = async (d: TestDaemon, of = conv("c1")) => {
  const snap = ok(await request(d.socketPath, { op: "snapshot" }, of));
  return snap.text ?? "";
};

describe("held dialogs", () => {
  it("click that opens a confirm replies with the dialog, and accept continues the page", async () => {
    const d = await daemon();
    const reply = ok(await openAndClick(d, "/confirm"));
    expect(reply.dialog).toMatchObject({ kind: "confirm", message: "Delete this draft?" });
    const dialog = reply.dialog as PendingDialogView;
    expect(dialog.id).toMatch(/^d\d+$/);
    // the blocked page: snapshot names the dialog, a click fails fast
    const snap = ok(await request(d.socketPath, { op: "snapshot" }));
    expect(snap.text).toContain(`blocked by a confirm dialog ${dialog.id}`);
    const refused = await request(d.socketPath, { op: "click_at", x: 5, y: 5 });
    expect(refused).toMatchObject({ ok: false, error: "dialog_open" });
    // a modal dialog stops the renderer: a screenshot is refused the same way
    const shot = await request(d.socketPath, { op: "screenshot", maxBytes: 500_000 });
    expect(shot).toMatchObject({ ok: false, error: "dialog_open" });
    const done = ok(await answer(d, dialog, "accept"));
    expect(done.text).toContain('Accepted the confirm dialog "Delete this draft?"');
    expect(done.dialog).toBeUndefined();
    expect(await outText(d)).toContain("yes");
  });

  it("dismiss answers a confirm; a prompt takes text or its default", async () => {
    const d = await daemon();
    const c = ok(await openAndClick(d, "/confirm")).dialog as PendingDialogView;
    ok(await answer(d, c, "dismiss"));
    expect(await outText(d)).toContain("no");
    const p = ok(await openAndClick(d, "/prompt")).dialog as PendingDialogView;
    expect(p).toMatchObject({ kind: "prompt", defaultValue: "Ann" });
    ok(await answer(d, p, "accept", { text: "Bo" }));
    expect(await outText(d)).toContain("got:Bo");
    const p2 = ok(await openAndClick(d, "/prompt")).dialog as PendingDialogView;
    ok(await answer(d, p2, "accept"));
    expect(await outText(d)).toContain("got:Ann");
  });

  it("an alert is closed at once and noted", async () => {
    const d = await daemon();
    const reply = ok(await openAndClick(d, "/alert"));
    expect(reply.dialog).toBeUndefined();
    expect(reply.text).toContain('The page showed an alert: "Saved" (closed).');
    expect(await outText(d)).toContain("after");
  });

  it("a stale dialogId and a mismatching message are refused", async () => {
    const d = await daemon();
    const dialog = ok(await openAndClick(d, "/confirm")).dialog as PendingDialogView;
    const stale = await answer(d, { ...dialog, id: "d999" }, "accept");
    expect(stale).toMatchObject({ ok: false, message: DIALOG_CHANGED_MESSAGE });
    const wrong = await answer(d, dialog, "accept", { message: "Keep this draft?" });
    expect(wrong).toMatchObject({ ok: false, message: DIALOG_CHANGED_MESSAGE });
    ok(await answer(d, dialog, "dismiss"));
    const none = await answer(d, dialog, "accept");
    expect(none).toMatchObject({ ok: false, message: NO_DIALOG_MESSAGE });
  });

  it("a message with newlines, quotes and an emoji at the clip boundary matches when copied from the dialog line", async () => {
    const d = await daemon();
    const dialog = ok(await openAndClick(d, "/long")).dialog as PendingDialogView;
    const snap = ok(await request(d.socketPath, { op: "snapshot" }));
    // the model copies the quoted (JSON) message, decoded
    const quoted = /dialog d\d+: ("(?:[^"\\]|\\.)*")/.exec(snap.text ?? "")?.[1];
    expect(quoted).toBeDefined();
    const copied = JSON.parse(quoted as string) as string;
    expect([...copied].length).toBeLessThanOrEqual(DIALOG_QUOTE_CHARS);
    expect(copied).toContain('"quoted"');
    ok(await answer(d, dialog, "dismiss", { message: copied }));
  });

  it.skipIf(SINGLE_PROCESS)(
    "browser_dialog answers while the opening click is still pending; another tab acts meanwhile",
    async () => {
      const d = await daemon();
      const dialog = ok(await openAndClick(d, "/confirm")).dialog as PendingDialogView;
      // the conversation's queue is free: a new tab opens and loads while the confirm is held
      ok(await request(d.socketPath, { op: "tabs", action: "open", url: `${fx.url}/plain` }));
      expect(await outText(d)).toContain("plain page");
      // the dialog's tab is no longer active, yet the reply still names it
      const back = ok(await request(d.socketPath, { op: "tabs", action: "list" }));
      expect(back.dialog?.id).toBe(dialog.id);
      ok(await answer(d, dialog, "accept"));
      ok(await request(d.socketPath, { op: "tabs", action: "switch", tabId: dialog.tabId }));
      expect(await outText(d)).toContain("yes");
    },
  );

  it("beforeunload accept lets the navigation go on", async () => {
    const d = await daemon();
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/leave` }));
    // a user gesture arms beforeunload
    ok(await request(d.socketPath, { op: "click_at", x: 5, y: 5 }));
    const nav = ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/plain` }));
    expect(nav.dialog?.kind).toBe("beforeunload");
    ok(await answer(d, nav.dialog as PendingDialogView, "accept"));
    ok(await request(d.socketPath, { op: "wait", text: "plain page", timeoutMs: 30_000 }));
    expect(await outText(d)).toContain("plain page");
  });

  it("a pending dialog survives until answered and is named in the next reply", async () => {
    const clock = new ShiftClock();
    const d = await daemon(clock);
    const dialog = ok(await openAndClick(d, "/confirm")).dialog as PendingDialogView;
    clock.advance(CONVERSATION_IDLE_MS + 60 * 60_000);
    const next = ok(await request(d.socketPath, { op: "tabs", action: "list" }));
    expect(next.dialog?.id).toBe(dialog.id);
    ok(await answer(d, dialog, "accept"));
  });
});

describe("dialogs and tab ownership", () => {
  it.runIf(SINGLE_PROCESS)(
    "in a one-process browser other requests are refused at once while a dialog is held",
    async () => {
      const d = await daemon();
      ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/plain` }, conv("c2")));
      const dialog = ok(await openAndClick(d, "/confirm", conv("c1"))).dialog as PendingDialogView;
      const other = await request(d.socketPath, { op: "snapshot" }, conv("c2"));
      expect(other).toMatchObject({ ok: false, message: PAUSED_BY_DIALOG_MESSAGE });
      expect(JSON.stringify(other)).not.toContain("Delete this draft");
      const own = await request(d.socketPath, { op: "tabs", action: "open" }, conv("c1"));
      expect(own).toMatchObject({ ok: false, error: "dialog_open" });
      // another conversation still cannot answer or adopt it
      const refused = await answer(d, dialog, "accept", {}, conv("c2"));
      expect(refused).toMatchObject({ ok: false, message: notYourTab(dialog.tabId) });
      const adopt = await request(
        d.socketPath,
        { op: "tabs", action: "adopt", tabId: dialog.tabId },
        conv("c2"),
      );
      expect(adopt).toMatchObject({ ok: false, message: tabInUse(dialog.tabId) });
      ok(await answer(d, dialog, "dismiss"));
      ok(await request(d.socketPath, { op: "snapshot" }, conv("c2")));
    },
  );

  it.skipIf(SINGLE_PROCESS)(
    "another conversation's dialogId is refused with the adopt text; replies show only own dialogs",
    async () => {
      const d = await daemon();
      const dialog = ok(await openAndClick(d, "/confirm", conv("c1"))).dialog as PendingDialogView;
      const other = ok(
        await request(d.socketPath, { op: "navigate", url: `${fx.url}/plain` }, conv("c2")),
      );
      expect(other.dialog).toBeUndefined();
      const refused = await answer(d, dialog, "accept", {}, conv("c2"));
      expect(refused).toMatchObject({ ok: false, message: notYourTab(dialog.tabId) });
      // adopt of the tab with the held dialog is refused (in use)
      const adopt = await request(
        d.socketPath,
        { op: "tabs", action: "adopt", tabId: dialog.tabId },
        conv("c2"),
      );
      expect(adopt).toMatchObject({ ok: false, message: tabInUse(dialog.tabId) });
      ok(await answer(d, dialog, "dismiss"));
    },
  );

  it("a dialog note reaches only the owner", async () => {
    const d = await daemon();
    ok(await request(d.socketPath, { op: "navigate", url: `${fx.url}/plain` }, conv("c2")));
    ok(await openAndClick(d, "/alert", conv("c1")));
    const c2 = ok(await request(d.socketPath, { op: "tabs", action: "list" }, conv("c2")));
    expect(c2.text ?? "").not.toContain("showed an alert");
    const c1 = ok(await request(d.socketPath, { op: "tabs", action: "list" }, conv("c1")));
    expect(c1.text ?? "").not.toContain("showed an alert");
  });

  it.skipIf(SINGLE_PROCESS)(
    "idle close keeps the tab with the held dialog and closes the owner's other tabs",
    async () => {
      const clock = new ShiftClock();
      const d = await daemon(clock);
      const dialog = ok(await openAndClick(d, "/confirm")).dialog as PendingDialogView;
      ok(await request(d.socketPath, { op: "tabs", action: "open", url: `${fx.url}/plain` }));
      clock.advance(CONVERSATION_IDLE_MS + 1000);
      await expect
        .poll(async () => {
          const list = ok(await request(d.socketPath, { op: "tabs", action: "list" }));
          return list.text ?? "";
        })
        .not.toContain("Plain");
      const list = ok(await request(d.socketPath, { op: "tabs", action: "list" }));
      expect(list.text).toContain(dialog.tabId);
      expect(list.dialog?.id).toBe(dialog.id);
    },
  );
});

describe("dialogs in viewers", () => {
  const stateWith = (pred: (s: Extract<ViewerOut, { t: "state" }>) => boolean) => (m: ViewerMsg) =>
    m.t === "state" && pred(m);

  it("state carries the tree's dialogs; a viewer answers only with control and only its tree", async () => {
    const d = await daemon();
    const dialog = ok(await openAndClick(d, "/confirm")).dialog as PendingDialogView;
    const own = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 }, conv("c1"));
    const other = await openViewer(d.socketPath, { maxWidth: 640, maxHeight: 400 }, conv("c9"));
    await own.next(stateWith((s) => s.dialogs.some((x) => x.id === dialog.id)));
    const otherState = await other.next(stateWith(() => true));
    expect((otherState as Extract<ViewerOut, { t: "state" }>).dialogs).toEqual([]);
    // without control: refused
    own.send({ t: "dialog", id: dialog.id, action: "accept" });
    // another tree's viewer, even in control: refused
    other.send({ t: "takeover" });
    await other.next(stateWith((s) => s.control === "user"));
    other.send({ t: "dialog", id: dialog.id, action: "accept" });
    // a stale id changes nothing
    own.send({ t: "dialog", id: "d999", action: "accept" });
    own.send({ t: "show", tabId: dialog.tabId });
    const still = await own.after(stateWith(() => true));
    expect((still as Extract<ViewerOut, { t: "state" }>).dialogs.map((x) => x.id)).toEqual([
      dialog.id,
    ]);
    own.send({ t: "dialog", id: dialog.id, action: "dismiss" });
    await own.after(stateWith((s) => s.dialogs.length === 0));
    own.send({ t: "handback" });
    await own.next(stateWith((s) => s.control === "agent"));
    expect(await outText(d)).toContain("no");
    await own.close();
    await other.close();
  });
});
