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
    ]) {
      expect(
        (await s.hit(key, { hosts: ["a.example"], callId: "c", done: true }, platform)).status,
      ).toBe(403);
      expect(
        (await s.hit(key, { hosts: ["a.example"], callId: "c", done: true }, noConv)).status,
      ).toBe(403);
      expect(
        (await s.hit(key, { hosts: ["a.example"], callId: "c", done: true }, share)).status,
      ).toBe(403);
    }
    expect(s.calls).toEqual([]);
  });

  it("network-hosts and handoff-answer pass the caller's scope", async () => {
    const s = setup();
    expect((await s.hit("POST /ui/network-hosts", { hosts: ["a.example"] }, conv)).status).toBe(
      200,
    );
    expect(
      (await s.hit("POST /ui/handoff-answer", { callId: "call-1", done: true }, conv)).status,
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
          done: true,
        },
      },
    ]);
  });

  it("invalid bodies answer 400", async () => {
    const s = setup();
    expect((await s.hit("POST /ui/network-hosts", { hosts: [] }, conv)).status).toBe(400);
    for (const bad of ["a..b", "-a.example", "a-.example", "a_b.example", `${"x".repeat(64)}.com`])
      expect((await s.hit("POST /ui/network-hosts", { hosts: [bad] }, conv)).status, bad).toBe(400);
    expect((await s.hit("POST /ui/handoff-answer", { callId: "c" }, conv)).status).toBe(400);
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
