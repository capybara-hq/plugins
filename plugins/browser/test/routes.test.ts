import { DeviceAccessError, type RouteCaller } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { type RouteDeps, registerRoutes } from "../src/routes.js";

type Handler = (req: Request, caller: RouteCaller) => Promise<Response>;

function setup(over: Partial<RouteDeps["deviceAccess"]> = {}) {
  const calls: { fn: string; arg: unknown }[] = [];
  const routes = new Map<string, Handler>();
  const deps: RouteDeps = {
    deviceAccess: {
      async streamTicket(arg) {
        calls.push({ fn: "streamTicket", arg });
        return {
          url: "wss://k.example/device/stream?ticket=abc",
          expiresAt: "2026-11-24T00:01:00Z",
        };
      },
      async addNetworkHosts(arg) {
        calls.push({ fn: "addNetworkHosts", arg });
      },
      async answerHandoff(arg) {
        calls.push({ fn: "answerHandoff", arg });
      },
      async grantLoopbackPort(arg) {
        calls.push({ fn: "grantLoopbackPort", arg });
        return {
          port: arg.port,
          source: "owner-panel",
          expiresAt: "2026-11-29T00:00:00Z",
          database: false,
        };
      },
      async revokeLoopbackPort(arg) {
        calls.push({ fn: "revokeLoopbackPort", arg });
      },
      async loopbackPorts(arg) {
        calls.push({ fn: "loopbackPorts", arg });
        return [
          { port: 3999, source: "owner-panel", expiresAt: "2026-11-29T00:00:00Z", database: false },
        ];
      },
      ...over,
    },
    panelScript: async () => "/* panel */",
  };
  registerRoutes(
    { http: { route: (method, path, h) => void routes.set(`${method} ${path}`, h as Handler) } },
    deps,
  );
  const hit = (key: string, body: unknown, caller: RouteCaller) => {
    const h = routes.get(key);
    if (!h) throw new Error(`no route ${key}`);
    const [method = "GET", path = ""] = key.split(" ");
    return h(
      new Request(`http://k/plugins/browser${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      caller,
    );
  };
  return { calls, routes, hit };
}

const conv: RouteCaller = {
  access: "embed",
  scope: "org",
  orgId: "org",
  accountId: "acc",
  role: "member",
  contribution: "browser",
  conversationId: "conv",
  exp: 9999999999,
  config: {},
};

describe("browser routes", () => {
  it("stream-ticket route passes caller account and conversation", async () => {
    const s = setup();
    const res = await s.hit("POST /ui/stream-ticket", {}, conv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "wss://k.example/device/stream?ticket=abc" });
    expect(s.calls).toEqual([
      {
        fn: "streamTicket",
        arg: { orgId: "org", conversationId: "conv", accountId: "acc", service: "browser" },
      },
    ]);
  });

  it("routes refuse a platform-scope caller", async () => {
    const s = setup();
    const platform: RouteCaller = {
      access: "embed",
      scope: "platform",
      accountId: "acc",
      role: "superAdmin",
      contribution: "browser",
      exp: 9999999999,
    };
    const { conversationId: _drop, ...noConv } = conv as Extract<RouteCaller, { scope: "org" }>;
    const share: RouteCaller = {
      access: "embed",
      scope: "share",
      orgId: "org",
      shareId: "s1",
      contribution: "browser",
      exp: 9999999999,
      config: {},
    };
    for (const key of [
      "POST /ui/stream-ticket",
      "POST /ui/network-hosts",
      "POST /ui/handoff-answer",
      "GET /ui/loopback-ports",
      "POST /ui/loopback-ports",
      "DELETE /ui/loopback-ports",
    ]) {
      const body = { hosts: ["a.example"], callId: "c", done: true, port: 3999 };
      expect((await s.hit(key, key.startsWith("GET") ? undefined : body, platform)).status).toBe(
        403,
      );
      expect((await s.hit(key, key.startsWith("GET") ? undefined : body, noConv)).status).toBe(403);
      expect((await s.hit(key, key.startsWith("GET") ? undefined : body, share)).status).toBe(403);
    }
    expect(s.calls).toEqual([]);
  });

  it("network-hosts and handoff-answer pass the caller's scope", async () => {
    const s = setup();
    expect((await s.hit("POST /ui/network-hosts", { hosts: ["a.example"] }, conv)).status).toBe(
      200,
    );
    expect(
      (
        await s.hit(
          "POST /ui/handoff-answer",
          { callId: "call-1", done: true, handoffConversationId: "conv" },
          conv,
        )
      ).status,
    ).toBe(200);
    expect(s.calls).toEqual([
      {
        fn: "addNetworkHosts",
        arg: { orgId: "org", conversationId: "conv", accountId: "acc", hosts: ["a.example"] },
      },
      {
        fn: "answerHandoff",
        arg: {
          orgId: "org",
          conversationId: "conv",
          accountId: "acc",
          callId: "call-1",
          handoffConversationId: "conv",
          done: true,
        },
      },
    ]);
  });

  it("handoff-answer passes the raising conversation the panel echoes (a sub-agent's)", async () => {
    const s = setup();
    const body = { callId: "call-1", done: false, handoffConversationId: "child" };
    expect((await s.hit("POST /ui/handoff-answer", body, conv)).status).toBe(200);
    expect(s.calls[0]?.arg).toMatchObject({ handoffConversationId: "child", done: false });
  });

  it("invalid bodies answer 400", async () => {
    const s = setup();
    expect((await s.hit("POST /ui/network-hosts", { hosts: [] }, conv)).status).toBe(400);
    for (const bad of ["a..b", "-a.example", "a-.example", "a_b.example", `${"x".repeat(64)}.com`])
      expect((await s.hit("POST /ui/network-hosts", { hosts: [bad] }, conv)).status, bad).toBe(400);
    expect((await s.hit("POST /ui/handoff-answer", { callId: "c" }, conv)).status).toBe(400);
    // the handoff's conversation is required: no default to the panel's own conversation
    for (const handoffConversationId of [undefined, 7, "", "x".repeat(201)])
      expect(
        (
          await s.hit(
            "POST /ui/handoff-answer",
            { callId: "c", done: true, handoffConversationId },
            conv,
          )
        ).status,
        String(handoffConversationId),
      ).toBe(400);
    expect(s.calls).toEqual([]);
  });

  it("a device access refusal answers its code", async () => {
    const s = setup({
      async streamTicket() {
        throw new DeviceAccessError("not_owner", "Only the owner");
      },
    });
    const res = await s.hit("POST /ui/stream-ticket", {}, conv);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_owner");
  });

  it("other errors are rethrown, never echoed", async () => {
    const s = setup({
      async streamTicket() {
        throw Object.assign(new Error("db password=hunter2"), { code: "ECONNREFUSED" });
      },
    });
    await expect(s.hit("POST /ui/stream-ticket", {}, conv)).rejects.toThrow("hunter2");
  });

  it("grants a port from the panel", async () => {
    const s = setup();
    const res = await s.hit("POST /ui/loopback-ports", { port: 3999 }, conv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      grant: {
        port: 3999,
        source: "owner-panel",
        expiresAt: "2026-11-29T00:00:00Z",
        database: false,
      },
    });
    expect(s.calls).toEqual([
      {
        fn: "grantLoopbackPort",
        arg: {
          orgId: "org",
          conversationId: "conv",
          accountId: "acc",
          service: "browser",
          port: 3999,
        },
      },
    ]);
  });

  it("refuses a non-integer or out-of-range port", async () => {
    const s = setup();
    for (const port of [0, 65536, 39.5, "3999", null, -1])
      for (const key of ["POST /ui/loopback-ports", "DELETE /ui/loopback-ports"])
        expect((await s.hit(key, { port }, conv)).status, `${key} ${String(port)}`).toBe(400);
    expect((await s.hit("POST /ui/loopback-ports", {}, conv)).status).toBe(400);
    expect(s.calls).toEqual([]);
  });

  it("lists and revokes", async () => {
    const s = setup();
    const list = await s.hit("GET /ui/loopback-ports", undefined, conv);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      ports: [
        { port: 3999, source: "owner-panel", expiresAt: "2026-11-29T00:00:00Z", database: false },
      ],
    });
    const del = await s.hit("DELETE /ui/loopback-ports", { port: 3999 }, conv);
    expect(del.status).toBe(200);
    const scope = { orgId: "org", conversationId: "conv", accountId: "acc", service: "browser" };
    expect(s.calls).toEqual([
      { fn: "loopbackPorts", arg: scope },
      { fn: "revokeLoopbackPort", arg: { ...scope, port: 3999 } },
    ]);
  });

  it("answers a loopback refusal with its code", async () => {
    const s = setup({
      async grantLoopbackPort() {
        throw new DeviceAccessError("loopback_unavailable", "Running outside the sandbox is off.");
      },
    });
    const res = await s.hit("POST /ui/loopback-ports", { port: 3999 }, conv);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "loopback_unavailable", message: "Running outside the sandbox is off." },
    });
    const bad = setup({
      async grantLoopbackPort() {
        throw new DeviceAccessError("invalid_request", "Port 0 is not a port.");
      },
    });
    expect((await bad.hit("POST /ui/loopback-ports", { port: 3999 }, conv)).status).toBe(400);
  });

  it("serves the panel page and script as public GETs", async () => {
    const s = setup();
    const pub: RouteCaller = { access: "public" };
    const page = await s.hit("GET /ui/browser", undefined, pub);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain("panel.js");
    const js = await s.hit("GET /ui/panel.js", undefined, pub);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(await js.text()).toBe("/* panel */");
  });
});

describe("manifest", () => {
  it("declares deviceAccess.loopbackPorts and the loopback-ports embed routes", async () => {
    const ext = (await import("../src/index.js")).default;
    expect(ext.permissions?.deviceAccess?.loopbackPorts).toBe(true);
    for (const method of ["GET", "POST", "DELETE"])
      expect(ext.permissions?.http).toContainEqual({
        method,
        path: "/ui/loopback-ports",
        access: "embed",
      });
  });

  it("declares the panel embed with the globe icon and the device service", async () => {
    const ext = (await import("../src/index.js")).default;
    expect(ext.ui).toEqual([
      {
        id: "browser",
        title: { zh: "浏览器", en: "Browser" },
        slot: "conversation.panel",
        kind: "embed",
        path: "/ui/browser",
        icon: "globe",
      },
    ]);
    expect(ext.permissions?.deviceAccess).toEqual({ services: ["browser"], loopbackPorts: true });
    expect(ext.permissions?.ui).toEqual({ embeds: ["browser"] });
  });
});
