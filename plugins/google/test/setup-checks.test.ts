import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type SetupCheckDefinition,
  type SetupCheckResult,
  type SetupCheckTarget,
  validateSetupCheckResult,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clientCheck,
  discoveryCheck,
  PROBE_CODE,
  PROBE_REDIRECT_URI,
} from "../src/setup-checks.js";

const CLIENT_ID = "cli-777.apps.googleusercontent.com";
const SECRET = "probe-secret-4b8e";
/** Every body the fake answers carries this marker; no result may contain it. */
const MARKER = "BODY-MARKER-91f3";

type Answer = { status: number; body?: unknown; raw?: string } | "close";
let server: Server;
let base: string;
let discovery: Answer;
let token: Answer;
let tokenRequests: URLSearchParams[];

function reply(res: import("node:http").ServerResponse, a: Answer) {
  if (a === "close") {
    res.socket?.destroy();
    return;
  }
  res.writeHead(a.status, { "content-type": "application/json" });
  res.end(a.raw ?? JSON.stringify({ ...(a.body as object), marker: MARKER }));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      if (req.url === "/.well-known/openid-configuration") return reply(res, discovery);
      if (req.url === "/token" && req.method === "POST") {
        tokenRequests.push(new URLSearchParams(raw));
        return reply(res, token);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const goodDiscovery = () => ({
  issuer: "https://accounts.google.com",
  authorization_endpoint: `${base}/authorize`,
  token_endpoint: `${base}/token`,
  jwks_uri: `${base}/jwks`,
  response_types_supported: ["code"],
});

beforeEach(() => {
  discovery = { status: 200, body: goodDiscovery() };
  token = { status: 400, body: { error: "invalid_grant", error_description: `bad ${MARKER}` } };
  tokenRequests = [];
});

const config = (over: Record<string, unknown> = {}) => ({
  clientId: CLIENT_ID,
  clientSecret: SECRET,
  endpoints: {
    authorizationUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    jwksUrl: `${base}/jwks`,
    discoveryUrl: `${base}/.well-known/openid-configuration`,
  },
  ...over,
});

async function run(
  check: SetupCheckDefinition,
  cfg: unknown = config(),
  o: { signal?: AbortSignal; target?: SetupCheckTarget } = {},
): Promise<SetupCheckResult> {
  expect(check.place).toBe("extension-deployment");
  const result = await check.run({
    orgId: null,
    config: cfg,
    locale: "en",
    mode: null,
    target: o.target ?? { kind: "extension-deployment", plugin: "google", config: cfg },
    signal: o.signal ?? new AbortController().signal,
  });
  expect(validateSetupCheckResult(result)).not.toHaveProperty("problem");
  const text = JSON.stringify(result);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(CLIENT_ID);
  expect(text).not.toContain(MARKER);
  return result;
}

describe("google-discovery", () => {
  it("ok when Google's endpoints match", async () => {
    expect((await run(discoveryCheck())).status).toBe("ok");
  });

  it("accepts the accounts.google.com issuer form", async () => {
    discovery = { status: 200, body: { ...goodDiscovery(), issuer: "accounts.google.com" } };
    expect((await run(discoveryCheck())).status).toBe("ok");
  });

  it("failing, naming the field, when token_endpoint changed", async () => {
    discovery = {
      status: 200,
      body: { ...goodDiscovery(), token_endpoint: "https://oauth2.googleapis.com/token2" },
    };
    const r = await run(discoveryCheck());
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toContain("token_endpoint");
    expect(r.reason?.en).not.toContain("token2");
    expect(r.fix?.en).toContain("Update the google plugin");
  });

  it("failing on an unknown issuer", async () => {
    discovery = { status: 200, body: { ...goodDiscovery(), issuer: "https://evil.example" } };
    const r = await run(discoveryCheck());
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toContain("issuer");
  });

  it.each([
    ["a 503", { status: 503, body: {} }],
    ["a 429", { status: 429, body: {} }],
    ["a redirect", { status: 302, body: {} }],
    ["non-JSON", { status: 200, raw: `<html>${MARKER}</html>` }],
    ["a dropped connection", "close"],
  ] as const)("unknown on %s", async (_name, a) => {
    discovery = a as Answer;
    expect((await run(discoveryCheck())).status).toBe("unknown");
  });

  it("unknown when aborted, without hanging", async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await run(discoveryCheck(), config(), { signal: ac.signal })).status).toBe("unknown");
  });

  it("unknown outside the platform page", async () => {
    const r = await run(discoveryCheck(), config(), {
      target: {
        kind: "connector",
        connectorId: "c",
        templateId: "t",
        clientId: null,
        accountId: null,
      },
    });
    expect(r.status).toBe("unknown");
  });
});

describe("google-client", () => {
  it("ok on invalid_grant; the probe sends the fixed code with client_secret_post", async () => {
    const r = await run(clientCheck());
    expect(r.status).toBe("ok");
    expect(tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(tokenRequests[0] ?? [])).toEqual({
      grant_type: "authorization_code",
      code: PROBE_CODE,
      redirect_uri: PROBE_REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    expect(PROBE_CODE).toBe("capybara-setup-probe");
  });

  it("trims a pasted client id and secret before probing", async () => {
    await run(clientCheck(), config({ clientId: ` ${CLIENT_ID}\n`, clientSecret: `${SECRET} ` }));
    expect(tokenRequests[0]?.get("client_id")).toBe(CLIENT_ID);
    expect(tokenRequests[0]?.get("client_secret")).toBe(SECRET);
  });

  it.each([
    ["invalid_client", { status: 401, body: { error: "invalid_client" } }],
    ["unauthorized_client", { status: 400, body: { error: "unauthorized_client" } }],
    ["a bare 401", { status: 401, raw: MARKER }],
  ] as const)("failing on %s with the re-copy fix", async (_name, a) => {
    token = a as Answer;
    const r = await run(clientCheck());
    expect(r.status).toBe("failing");
    expect(r.fix?.en).toContain("Copy the client ID and secret again");
  });

  it("failing without a client id, before any request", async () => {
    const r = await run(clientCheck(), config({ clientId: undefined }));
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toBe("No client ID is saved.");
    expect(tokenRequests).toHaveLength(0);
  });

  it("failing without a secret, before any request", async () => {
    const r = await run(clientCheck(), config({ clientSecret: undefined }));
    expect(r.status).toBe("failing");
    expect(tokenRequests).toHaveLength(0);
  });

  it("failing on an invalid config, naming fields only", async () => {
    const r = await run(clientCheck(), config({ allowedDomains: ["gmail.com"] }));
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toContain("allowedDomains");
    expect(r.reason?.zh).toContain("allowedDomains");
    expect(tokenRequests).toHaveLength(0);
  });

  it.each([
    ["a 2xx (never stored)", { status: 200, body: { access_token: MARKER, id_token: MARKER } }],
    ["invalid_grant on a 302", { status: 302, body: { error: "invalid_grant" } }],
    ["invalid_grant on a 500", { status: 500, body: { error: "invalid_grant" } }],
    [
      "an oversized body",
      { status: 400, raw: JSON.stringify({ error: "invalid_grant", pad: "x".repeat(70_000) }) },
    ],
    ["redirect_uri_mismatch", { status: 400, body: { error: "redirect_uri_mismatch" } }],
    ["an odd error code", { status: 400, body: { error: `Bad ${MARKER}` } }],
    ["a 503", { status: 503, body: {} }],
    ["a 429", { status: 429, body: {} }],
    ["non-JSON", { status: 400, raw: MARKER }],
    ["a dropped connection", "close"],
  ] as const)("unknown on %s", async (_name, a) => {
    token = a as Answer;
    expect((await run(clientCheck())).status).toBe("unknown");
  });

  it("unknown when aborted, without hanging", async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await run(clientCheck(), config(), { signal: ac.signal })).status).toBe("unknown");
  });
});
