import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type SetupCheckArgs,
  type SetupCheckDefinition,
  type SetupCheckResult,
  validateSetupCheckResult,
} from "@capybara-hq/plugin-sdk";
import { type FakeSlackServer, startFakeSlack } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin, {
  appTokenCheck,
  botScopesCheck,
  botTokenCheck,
  REQUIRED_BOT_SCOPES,
} from "../src/index.js";

/**
 * The setup checks of the slack-app guide (spec 2026-11-09-setup-guides-v2-design.md §10) against
 * the fake Slack. Every result must validate, and no reason or fix may carry a token.
 */
let slack: FakeSlackServer;
const servers: Server[] = [];

beforeAll(async () => {
  slack = await startFakeSlack({ teamId: "T1", botUserId: "UBOT" });
});
afterAll(async () => {
  await slack?.stop();
  for (const s of servers) await new Promise((r) => s.close(r));
});

const opts = () => ({ apiUrl: () => slack.apiUrl });
const target = (config: Record<string, unknown>) => ({
  kind: "channel-connection" as const,
  connectionId: "conn-1",
  config,
});
const args = (
  config: Record<string, unknown>,
  over: Partial<SetupCheckArgs> = {},
): SetupCheckArgs => ({
  orgId: "org-1",
  config: {},
  locale: "en",
  mode: "long_connection",
  target: target(config),
  signal: new AbortController().signal,
  ...over,
});
const tokens = () => ({ botToken: slack.botToken, appToken: slack.appToken });

/** Runs a check and asserts the contract on its result: valid, zh present, no secret text. */
async function run(def: SetupCheckDefinition, a: SetupCheckArgs): Promise<SetupCheckResult> {
  expect(def.place).toBe("channel-connection");
  const r = await def.run(a);
  const v = validateSetupCheckResult(r);
  expect("problem" in v ? v.problem : undefined).toBeUndefined();
  const texts = [r.reason?.en, r.reason?.zh, r.fix?.en, r.fix?.zh].filter(
    (t): t is string => t !== undefined,
  );
  if (r.status !== "ok") expect(r.reason).toBeDefined();
  if (r.status === "failing") expect(r.fix).toBeDefined();
  for (const t of [r.reason, r.fix]) if (t) expect(t.zh).toBeTruthy();
  const secrets = [slack.botToken, slack.appToken, "xoxb-secret-value", "xapp-secret-value"];
  for (const t of texts) for (const s of secrets) expect(t).not.toContain(s);
  return r;
}

/** A Slack Web API stub answering `auth.test` with the given `x-oauth-scopes` header. */
async function scopesServer(scopes: string): Promise<string> {
  const s = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "x-oauth-scopes": scopes });
      res.end(
        JSON.stringify({
          ok: true,
          team: "Fake Team",
          team_id: "T1",
          user_id: "UBOT",
          bot_id: "B1",
        }),
      );
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/`;
}

describe("the extension registers its checks", () => {
  it("in setup, once each, for the channel-connection place", () => {
    const registered = new Map<string, SetupCheckDefinition>();
    const ctx = {
      config: {},
      log: { info() {}, warn() {}, error() {}, debug() {} },
      kv: {},
      provide() {},
      setup: {
        check(id: string, def: SetupCheckDefinition) {
          expect(registered.has(id)).toBe(false);
          registered.set(id, def);
        },
      },
    };
    plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0]);
    expect([...registered.keys()]).toEqual(["bot-token", "bot-scopes", "app-token"]);
    expect([...registered.keys()].sort()).toEqual(
      [...(plugin.permissions?.setupChecks ?? [])].sort(),
    );
    for (const def of registered.values()) expect(def.place).toBe("channel-connection");
  });
});

describe("bot-token", () => {
  it("ok: Slack accepted the token, naming the workspace", async () => {
    const r = await run(botTokenCheck(opts()), args(tokens()));
    expect(r.status).toBe("ok");
    expect(r.reason?.en).toBe("Slack accepted the bot token for workspace Fake Team (T1).");
    expect(slack.calls.at(-1)).toMatchObject({ method: "auth.test", token: slack.botToken });
  });

  it("a wrong token is failing with the reinstall fix", async () => {
    const r = await run(botTokenCheck(opts()), args({ botToken: "xoxb-secret-value" }));
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toContain("invalid_auth");
    expect(r.fix?.en).toContain("reinstall the app");
  });

  for (const code of ["token_revoked", "account_inactive", "not_authed"]) {
    it(`${code} is failing with the reinstall fix`, async () => {
      slack.failNext("auth.test", { error: code });
      const r = await run(botTokenCheck(opts()), args(tokens()));
      expect(r.status).toBe("failing");
      expect(r.reason?.en).toContain(code);
      expect(r.fix?.en).toContain("Bot User OAuth Token");
    });
  }

  it("not_allowed_token_type is failing: copy the bot token, not another kind", async () => {
    slack.failNext("auth.test", { error: "not_allowed_token_type" });
    const r = await run(botTokenCheck(opts()), args(tokens()));
    expect(r.status).toBe("failing");
    expect(r.fix?.en).toContain("not a user or app-level token");
  });

  it("missing_scope is failing with the manifest fix", async () => {
    slack.failNext("auth.test", { error: "missing_scope" });
    const r = await run(botTokenCheck(opts()), args(tokens()));
    expect(r.status).toBe("failing");
    expect(r.fix?.en).toContain("App Manifest");
  });

  it("rate limits and Slack outages are unknown, never failing", async () => {
    slack.failNext("auth.test", { error: "ratelimited" });
    expect((await run(botTokenCheck(opts()), args(tokens()))).status).toBe("unknown");
    slack.failNext("auth.test", { status: 429, retryAfter: 30 });
    const limited = await run(botTokenCheck(opts()), args(tokens()));
    expect(limited).toMatchObject({ status: "unknown" });
    expect(limited.reason?.en).toContain("rate limiting");
    slack.failNext("auth.test", { error: "internal_error" });
    expect((await run(botTokenCheck(opts()), args(tokens()))).status).toBe("unknown");
    slack.failNext("auth.test", { status: 503 });
    expect((await run(botTokenCheck(opts()), args(tokens()))).status).toBe("unknown");
  });

  it("does not retry: one call per run, even when rate limited", async () => {
    const before = slack.calls.length;
    slack.failNext("auth.test", { status: 429, retryAfter: 1 });
    await run(botTokenCheck(opts()), args(tokens()));
    expect(slack.calls.length - before).toBe(1);
  });

  it("an org-wide install is failing (the tenant is a workspace)", async () => {
    slack.failNext("auth.test", {
      body: { ok: true, team: "Grid", team_id: "E1", is_enterprise_install: true, bot_id: "B1" },
    });
    const r = await run(botTokenCheck(opts()), args(tokens()));
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toContain("org-wide");
  });

  it("a workspace name with control or bidi characters is cleaned", async () => {
    slack.failNext("auth.test", {
      body: { ok: true, team: "Ac‮me\n", team_id: "T1", user_id: "UBOT", bot_id: "B1" },
    });
    const r = await run(botTokenCheck(opts()), args(tokens()));
    expect(r.reason?.en).toBe("Slack accepted the bot token for workspace Acme (T1).");
  });

  it("an unknown error code is unknown and a malformed one is not echoed", async () => {
    slack.failNext("auth.test", { error: "xoxb-secret-value <b>" });
    const r = await run(botTokenCheck(opts()), args(tokens()));
    expect(r.status).toBe("unknown");
    expect(r.reason?.en).toContain("unknown_error");
  });

  it("no bot token is failing; a connector target is unknown", async () => {
    expect((await run(botTokenCheck(opts()), args({}))).status).toBe("failing");
    const r = await botTokenCheck(opts()).run({
      ...args({}),
      target: {
        kind: "connector",
        connectorId: "c1",
        templateId: "slack",
        clientId: null,
        accountId: null,
      },
    });
    expect(r.status).toBe("unknown");
  });

  it("honors signal: a hanging Slack yields unknown once the kernel aborts", async () => {
    slack.delay("auth.test", 5000);
    try {
      const started = Date.now();
      const r = await run(
        botTokenCheck(opts()),
        args(tokens(), { signal: AbortSignal.timeout(100) }),
      );
      expect(r.status).toBe("unknown");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      slack.delay("auth.test", 0);
    }
  });

  it("an unreachable Slack is unknown", async () => {
    const r = await run(botTokenCheck({ apiUrl: () => "http://127.0.0.1:1/api/" }), args(tokens()));
    expect(r.status).toBe("unknown");
    expect(r.reason?.en).toContain("Could not reach Slack");
  });
});

describe("bot-scopes", () => {
  it("ok when the token has every scope of the manifest (extra scopes are fine)", async () => {
    const apiUrl = await scopesServer([...REQUIRED_BOT_SCOPES, "reactions:write"].join(","));
    const r = await run(botScopesCheck({ apiUrl: () => apiUrl }), args(tokens()));
    expect(r.status).toBe("ok");
  });

  it("failing naming the missing scopes, with the paste-and-reinstall fix", async () => {
    const granted = REQUIRED_BOT_SCOPES.filter((s) => s !== "users:read.email" && s !== "commands");
    const apiUrl = await scopesServer(granted.join(", "));
    const r = await run(botScopesCheck({ apiUrl: () => apiUrl }), args(tokens()));
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toBe("The app is missing the bot scopes commands, users:read.email.");
    expect(r.fix?.en).toContain("App Manifest");
    expect(r.fix?.en).toContain("reinstall");
  });

  it("unknown when Slack reports no scopes", async () => {
    // The fake Slack sends no x-oauth-scopes header
    const r = await run(botScopesCheck(opts()), args(tokens()));
    expect(r.status).toBe("unknown");
  });

  it("a refused token is unknown here (the bot-token row carries the failure)", async () => {
    const r = await run(botScopesCheck(opts()), args({ botToken: "xoxb-secret-value" }));
    expect(r.status).toBe("unknown");
    expect(r.reason?.en).toContain("invalid_auth");
  });

  it("unknown without a bot token", async () => {
    expect((await run(botScopesCheck(opts()), args({}))).status).toBe("unknown");
  });
});

describe("app-token", () => {
  it("ok: apps.connections.open accepted the app token, no socket opened", async () => {
    const opened = slack.connectionsOpened();
    const r = await run(appTokenCheck(opts()), args(tokens()));
    expect(r.status).toBe("ok");
    expect(slack.connectionsOpened()).toBe(opened + 1);
    expect(slack.openSockets()).toBe(0);
    expect(slack.calls.at(-1)).toMatchObject({
      method: "apps.connections.open",
      token: slack.appToken,
    });
  });

  it("a refused app token is failing with the generate-token fix", async () => {
    const r = await run(
      appTokenCheck(opts()),
      args({ botToken: slack.botToken, appToken: "xapp-secret-value" }),
    );
    expect(r.status).toBe("failing");
    expect(r.reason?.en).toContain("invalid_auth");
    expect(r.fix?.en).toContain("connections:write");
  });

  for (const code of ["missing_scope", "not_allowed_token_type"]) {
    it(`${code} is failing`, async () => {
      slack.failNext("apps.connections.open", { error: code });
      const r = await run(appTokenCheck(opts()), args(tokens()));
      expect(r.status).toBe("failing");
      expect(r.reason?.en).toContain(code);
    });
  }

  it("rate limited is unknown", async () => {
    slack.failNext("apps.connections.open", { error: "ratelimited" });
    expect((await run(appTokenCheck(opts()), args(tokens()))).status).toBe("unknown");
  });

  it("a missing app token is failing in long connection mode", async () => {
    const r = await run(appTokenCheck(opts()), args({ botToken: slack.botToken }));
    expect(r.status).toBe("failing");
    expect(r.fix?.en).toContain("App-Level Tokens");
  });

  it("webhook mode is unknown and calls nothing", async () => {
    const before = slack.calls.length;
    const r = await run(appTokenCheck(opts()), args(tokens(), { mode: "webhook" }));
    expect(r.status).toBe("unknown");
    expect(slack.calls.length).toBe(before);
  });

  it("honors signal", async () => {
    slack.delay("apps.connections.open", 5000);
    try {
      const r = await run(
        appTokenCheck(opts()),
        args(tokens(), { signal: AbortSignal.timeout(100) }),
      );
      expect(r.status).toBe("unknown");
    } finally {
      slack.delay("apps.connections.open", 0);
    }
  });
});
