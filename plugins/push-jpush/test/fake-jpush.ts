import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PushOutcome, PushVendorRequest } from "@capybara-hq/testing";

/** A scripted answer of the fake: status, JSON body and headers. */
export interface FakeAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** One request that reached the fake, as received. */
export interface FakeJPushRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  /** Parsed JSON body of a POST (undefined for a GET). */
  body: unknown;
}

export interface FakeJPush {
  /** Base URL (`http://127.0.0.1:<port>`), standing in for `https://api.jpush.cn`. */
  url: string;
  appKey: string;
  masterSecret: string;
  /** Makes `/v3/push` answer `outcome` for this registration id (default delivered). */
  arrange(token: string, outcome: PushOutcome | FakeAnswer): void;
  /** Makes `/v3/push/cid` answer this (default: a cid list when the credentials match). */
  arrangeCid(answer: FakeAnswer | "network_error"): void;
  /** Every request that reached the fake. */
  requests: FakeJPushRequest[];
  /** The `/v3/push` requests as the conformance suite reads them. */
  vendorRequests(): PushVendorRequest[];
  stop(): Promise<void>;
}

const err = (status: number, code: number, message: string, headers?: Record<string, string>) => ({
  status,
  body: { error: { code, message } },
  ...(headers && { headers }),
});

/** The answers of the documented JPush codes for each conformance outcome. */
const OUTCOMES: Record<Exclude<PushOutcome, "network_error" | "hang">, FakeAnswer> = {
  delivered: { status: 200, body: { sendno: "0", msg_id: "18100287008546343" } },
  unregistered: err(400, 1011, "cannot find user by this audience"),
  auth: err(401, 1004, "Authen failed"),
  rate_limited: err(429, 2002, "Rate limit exceeded", {
    "X-Rate-Limit-Limit": "600",
    "X-Rate-Limit-Remaining": "0",
    "X-Rate-Limit-Reset": "7",
  }),
  transient: err(500, 1000, "Server Internal error"),
};

/**
 * A local stand-in for JPush's REST API (`POST /v3/push`, `GET /v3/push/cid`), checking HTTP Basic
 * `appKey:masterSecret` like the real one (1004 on a mismatch).
 */
export async function startFakeJPush(
  opts: { appKey?: string; masterSecret?: string } = {},
): Promise<FakeJPush> {
  const appKey = opts.appKey ?? "8103a4c628a0b98994ec1949";
  const masterSecret = opts.masterSecret ?? "fake-master-secret-0123456789";
  const expectedAuth = `Basic ${Buffer.from(`${appKey}:${masterSecret}`).toString("base64")}`;
  const outcomes = new Map<string, PushOutcome | FakeAnswer>();
  let cid: FakeAnswer | "network_error" | undefined;
  const requests: FakeJPushRequest[] = [];

  const send = (res: ServerResponse, a: FakeAnswer) => {
    res.writeHead(a.status, { "content-type": "application/json", ...a.headers });
    res.end(a.body === undefined ? "" : JSON.stringify(a.body));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const body = req.method === "POST" && text !== "" ? (JSON.parse(text) as unknown) : undefined;
      requests.push({
        method: req.method ?? "",
        path,
        authorization: req.headers.authorization,
        body,
      });
      if (req.method === "GET" && path === "/v3/push/cid") {
        if (cid === "network_error") return void req.socket.destroy();
        if (cid !== undefined) return send(res, cid);
        if (req.headers.authorization !== expectedAuth) return send(res, OUTCOMES.auth);
        return send(res, {
          status: 200,
          body: { cidlist: [`${appKey}-1c2b3a4d-0000-4000-8000-000000000001`] },
        });
      }
      if (req.method !== "POST" || path !== "/v3/push") {
        return send(res, err(404, 1001, "Only support HTTP Post method"));
      }
      if (req.headers.authorization !== expectedAuth) return send(res, OUTCOMES.auth);
      const token = (body as { audience?: { registration_id?: string[] } }).audience
        ?.registration_id?.[0];
      const outcome = (token !== undefined && outcomes.get(token)) || "delivered";
      if (outcome === "network_error") return void req.socket.destroy();
      if (outcome === "hang") return; // never answers; stop() closes the socket
      send(res, typeof outcome === "string" ? OUTCOMES[outcome] : outcome);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    appKey,
    masterSecret,
    arrange: (token, outcome) => void outcomes.set(token, outcome),
    arrangeCid: (a) => {
      cid = a;
    },
    requests,
    vendorRequests: () =>
      requests
        .filter((r) => r.method === "POST" && r.path === "/v3/push")
        .map((r) => {
          const b = r.body as {
            audience: { registration_id: string[] };
            notification: {
              android: { title: string; alert: string; extras: Record<string, string> };
            };
          };
          const a = b.notification.android;
          return {
            token: b.audience.registration_id[0] as string,
            title: a.title,
            body: a.alert,
            path: a.extras.path as string,
            origin: a.extras.origin as string,
            threadId: a.extras.threadId as string,
            collapseId: a.extras.collapseId as string,
          };
        }),
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
