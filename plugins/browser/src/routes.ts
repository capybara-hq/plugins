// The panel's routes (browser use spec §8, writing-extension-ui): the page and its script are
// public GETs that carry no data; the data routes are `embed` routes, so the kernel verified the
// embed token before the handler runs. Org, account and conversation come only from `caller`.
//
// The panel never starts the service. A ticket is minted whether or not the daemon runs (the
// kernel's streamTicket does not look at the service, and nothing short of a tool call may start
// it); when the service is stopped, the kernel closes the viewer socket with 4404 and the panel
// shows its "not running" state. `service_not_running` is the code reserved for that state in a
// ticket answer, should the kernel ever report it at mint time.
import type { DeviceAccessCtx, RouteCaller } from "@capybara-hq/plugin-sdk";
import { PANEL_HTML } from "../ui-src/panel/page.js";
import { SERVICE } from "./browser.js";

/** What the routes need: the kernel's device access and the built panel script. */
export interface RouteDeps {
  deviceAccess: Pick<DeviceAccessCtx, "streamTicket" | "addNetworkHosts" | "answerHandoff">;
  /** The panel's browser bundle (`ui/panel.js`, built by build-ui.ts). */
  panelScript: () => Promise<string | undefined>;
}

type Handler = (req: Request, caller: RouteCaller) => Promise<Response>;

/** The most hosts one allow may add (the panel sends one). */
const MAX_HOSTS = 20;
/** A DNS name: labels of 1-63 letters, digits and inner hyphens (the kernel validates again). */
const HOST_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const CALL_ID_MAX = 200;

/** Defense in depth if the kernel's /plugins is ever reached without the web proxy. */
const STATIC_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox allow-scripts allow-forms; frame-ancestors 'self'",
  "cache-control": "no-cache",
} as const;

const json = (status: number, body: unknown) => Response.json(body, { status });
const error = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

/** The caller's org, account and conversation, or null: only a conversation embed token. */
function scopeOf(
  caller: RouteCaller,
): { orgId: string; accountId: string; conversationId: string } | null {
  if (caller.access !== "embed" || caller.scope !== "org") return null;
  if (caller.conversationId === undefined || caller.conversationId === "") return null;
  return {
    orgId: caller.orgId,
    accountId: caller.accountId,
    conversationId: caller.conversationId,
  };
}

/** HTTP status for a kernel refusal code. */
function statusOf(code: string): number {
  if (code === "not_owner") return 403;
  if (code === "question.not_found") return 404;
  if (code === "service_not_declared") return 500;
  return 409;
}

/** The kernel's refusals whose message is meant for the caller. */
const isRefusalName = (name: string) => name === "DeviceAccessError" || name === "ApiError";

/**
 * A kernel refusal (DeviceAccessError, ApiError, matched by name) as an error body with its code
 * and message; anything else is rethrown (the kernel answers it without echoing the message).
 */
function refusal(e: unknown): Response {
  const code = (e as { code?: unknown } | null)?.code;
  if (!(e instanceof Error) || !isRefusalName(e.name) || typeof code !== "string") throw e;
  return error(statusOf(code), code, e.message);
}

async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const v: unknown = await req.json();
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A data route: refuses anything but a conversation embed token, maps refusals to codes. */
function data(
  run: (
    scope: { orgId: string; accountId: string; conversationId: string },
    req: Request,
  ) => Promise<Response>,
): Handler {
  return async (req, caller) => {
    const scope = scopeOf(caller);
    if (scope === null)
      return error(403, "forbidden", "The browser panel needs a conversation embed token");
    try {
      return await run(scope, req);
    } catch (e) {
      return refusal(e);
    }
  };
}

/** Registers the panel's routes. */
export function registerRoutes(
  ctx: { http: { route(method: "GET" | "POST", path: string, handler: Handler): void } },
  deps: RouteDeps,
): void {
  ctx.http.route("GET", "/ui/browser", async () => {
    return new Response(PANEL_HTML, {
      headers: { "content-type": "text/html; charset=utf-8", ...STATIC_HEADERS },
    });
  });

  ctx.http.route("GET", "/ui/panel.js", async () => {
    const js = await deps.panelScript();
    if (js === undefined) return error(404, "not_found", "The panel script is not built");
    return new Response(js, {
      headers: { "content-type": "text/javascript; charset=utf-8", ...STATIC_HEADERS },
    });
  });

  ctx.http.route(
    "POST",
    "/ui/stream-ticket",
    data(async (scope) => {
      const { url } = await deps.deviceAccess.streamTicket({ ...scope, service: SERVICE });
      return json(200, { url });
    }),
  );

  ctx.http.route(
    "POST",
    "/ui/network-hosts",
    data(async (scope, req) => {
      const body = await readJson(req);
      const hosts = body?.hosts;
      if (
        !Array.isArray(hosts) ||
        hosts.length === 0 ||
        hosts.length > MAX_HOSTS ||
        !hosts.every((h) => typeof h === "string" && HOST_RE.test(h))
      )
        return error(400, "invalid_body", `hosts must list 1 to ${MAX_HOSTS} host names`);
      await deps.deviceAccess.addNetworkHosts({ ...scope, hosts: hosts as string[] });
      return json(200, { ok: true });
    }),
  );

  ctx.http.route(
    "POST",
    "/ui/handoff-answer",
    data(async (scope, req) => {
      const body = await readJson(req);
      const callId = body?.callId;
      const done = body?.done;
      if (
        typeof callId !== "string" ||
        callId === "" ||
        callId.length > CALL_ID_MAX ||
        typeof done !== "boolean"
      )
        return error(400, "invalid_body", "the body must be { callId: string, done: boolean }");
      await deps.deviceAccess.answerHandoff({ ...scope, callId, done });
      return json(200, { ok: true });
    }),
  );
}
