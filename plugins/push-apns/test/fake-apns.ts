import { readFileSync } from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import type { PushOutcome, PushVendorRequest } from "@capybara-hq/testing";

/**
 * A fake APNs: an HTTP/2 server on 127.0.0.1 with the TEST-ONLY self-signed certificate in
 * `fixtures/` (never used outside tests). It records every `POST /3/device/<token>` and answers
 * per token as arranged: a conformance outcome or an exact status and reason.
 */

/** The TEST-ONLY certificate authority a client needs to trust the fake (its own certificate). */
export const FAKE_APNS_CA = readFileSync(
  new URL("./fixtures/test-only-tls-cert.pem", import.meta.url),
  "utf8",
);
const FAKE_APNS_KEY = readFileSync(
  new URL("./fixtures/test-only-tls-key.pem", import.meta.url),
  "utf8",
);

/** One request as it reached the fake, with every header. */
export interface FakeApnsRequest {
  token: string;
  headers: Record<string, string>;
  body: unknown;
}

/** An exact answer, or a way to fail without one. */
export type FakeApnsAnswer =
  | { status: number; reason?: string; headers?: Record<string, string> }
  | { network: "reset" }
  | { network: "hang" };

export interface FakeApns {
  /** `https://127.0.0.1:<port>`. */
  url: string;
  /** Every request, in arrival order. */
  received: FakeApnsRequest[];
  /** Answers `answer` for `token` (default: 200). */
  respond(token: string, answer: FakeApnsAnswer): void;
  /** Answers a conformance outcome for `token`. */
  arrange(token: string, outcome: PushOutcome): void;
  /** The requests as the conformance suite checks them. */
  requests(): PushVendorRequest[];
  close(): Promise<void>;
}

const OUTCOMES: Record<PushOutcome, FakeApnsAnswer> = {
  delivered: { status: 200 },
  unregistered: { status: 410, reason: "Unregistered" },
  auth: { status: 403, reason: "InvalidProviderToken" },
  rate_limited: { status: 429, reason: "TooManyRequests" },
  transient: { status: 503, reason: "ServiceUnavailable" },
  network_error: { network: "reset" },
  hang: { network: "hang" },
};

export async function startFakeApns(): Promise<FakeApns> {
  const answers = new Map<string, FakeApnsAnswer>();
  const received: FakeApnsRequest[] = [];
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createSecureServer({ key: FAKE_APNS_KEY, cert: FAKE_APNS_CA });
  server.on("session", (s) => {
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
    s.on("error", () => {});
  });
  server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    stream.on("error", () => {});
    const path = String(headers[":path"] ?? "");
    const m = /^\/3\/device\/([^/?]+)$/.exec(path);
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      if (headers[":method"] !== "POST" || !m) {
        stream.respond({ ":status": 404 });
        stream.end(JSON.stringify({ reason: "BadPath" }));
        return;
      }
      const token = decodeURIComponent(m[1] as string);
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (!k.startsWith(":") && v !== undefined) flat[k] = String(v);
      }
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = Buffer.concat(chunks).toString("utf8");
      }
      received.push({ token, headers: flat, body });
      const answer = answers.get(token) ?? { status: 200 };
      if ("network" in answer) {
        if (answer.network === "reset") stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
        return; // hang: never answers; the client's abort or close() ends the stream
      }
      stream.respond({
        ":status": answer.status,
        "apns-id": "00000000-0000-0000-0000-000000000001",
        ...answer.headers,
      });
      stream.end(
        answer.reason === undefined ? undefined : JSON.stringify({ reason: answer.reason }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}`,
    received,
    respond: (token, answer) => answers.set(token, answer),
    arrange: (token, outcome) => answers.set(token, OUTCOMES[outcome]),
    requests: () =>
      received.map((r) => {
        const b = r.body as {
          aps?: { alert?: { title?: string; body?: string }; "thread-id"?: string };
          path?: string;
          origin?: string;
        };
        return {
          token: r.token,
          title: b.aps?.alert?.title ?? "",
          body: b.aps?.alert?.body ?? "",
          path: b.path ?? "",
          origin: b.origin ?? "",
          threadId: b.aps?.["thread-id"] ?? "",
          collapseId: r.headers["apns-collapse-id"] ?? "",
        };
      }),
    close: async () => {
      for (const s of sessions) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
