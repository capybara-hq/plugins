import { mkdtemp, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import { type AddressInfo, connect, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxProxyRefusalLayer } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  controlRequest,
  createControlServer,
  createEgressProxy,
  createEgressState,
  type EgressState,
  operationTag,
  REFUSAL_REASONS,
} from "../egress-proxy/proxy.mjs";
import { taggedProxyEnv } from "../src/provider.js";
import { blockedHosts } from "../src/refusals.js";

/**
 * The egress proxy's refusals (no Docker): each refusal names the SDK's sandbox proxy reason as its
 * status phrase, and a request carrying an operation's tag has its refusals recorded for that
 * operation, which the provider takes through the control socket and reports with the SDK's layers.
 */

const TAG = "0123456789abcdef0123456789abcdef";
const basic = (user: string) => `Basic ${Buffer.from(user).toString("base64")}`;

describe("refusal reasons", () => {
  it("are the SDK's sandbox proxy vocabulary, each with the layer it stands for", () => {
    expect(
      Object.fromEntries(
        Object.entries(REFUSAL_REASONS).map(([k, v]) => [k, sandboxProxyRefusalLayer(v)]),
      ),
    ).toEqual({
      malformed: "address",
      literal: "address",
      resolved: "address",
      offList: "device",
      fakeIp: "unknown",
    });
  });

  it("reads an operation tag only from the provider's credentials", () => {
    expect(operationTag(basic(`capybara:${TAG}`))).toBe(TAG);
    expect(operationTag(` ${basic(`capybara:${TAG}`)} `)).toBe(TAG);
    expect(operationTag(basic(`capybara:${TAG.toUpperCase()}`))).toBeNull();
    expect(operationTag(basic("capybara:short"))).toBeNull();
    expect(operationTag(basic(`other:${TAG}`))).toBeNull();
    expect(operationTag(`Bearer ${TAG}`)).toBeNull();
    expect(operationTag(undefined)).toBeNull();
    // the provider's proxy URL carries exactly these credentials
    const url = new URL(taggedProxyEnv("cap-x", TAG).HTTPS_PROXY ?? "");
    expect(operationTag(basic(`${url.username}:${url.password}`))).toBe(TAG);
    expect(taggedProxyEnv("cap-x", TAG)).toMatchObject({
      HTTP_PROXY: `http://capybara:${TAG}@cap-x-egress:3128`,
      ALL_PROXY: `http://capybara:${TAG}@cap-x-egress:3128`,
    });
  });
});

describe("refusals through the proxy", () => {
  let state: EgressState;
  let proxy: Server;
  let port: number;
  let open: Server;
  let openState: EgressState;
  let openPort: number;
  let control: NetServer;
  let dir: string;
  const lookup = async (h: string) => {
    if (h === "rebind.example.com") return [{ address: "10.0.0.1" }];
    if (h === "fake.example.com") return [{ address: "198.18.0.9" }];
    throw new Error("ENOTFOUND");
  };
  const failingDns = {
    resolve: async () => {
      throw new Error("timed out");
    },
  };

  beforeAll(async () => {
    state = createEgressState({
      mode: "allowlist",
      allowHosts: ["*.example.com"],
      log: () => {},
    });
    proxy = createEgressProxy({ state, lookup, encryptedDns: failingDns, log: () => {} });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    port = (proxy.address() as AddressInfo).port;
    openState = createEgressState({ mode: "open-public", log: () => {} });
    open = createEgressProxy({
      state: openState,
      lookup,
      encryptedDns: failingDns,
      log: () => {},
    });
    await new Promise<void>((r) => open.listen(0, "127.0.0.1", r));
    openPort = (open.address() as AddressInfo).port;
    dir = await mkdtemp(join(tmpdir(), "egress-refusals-"));
    control = createControlServer(state);
    await new Promise<void>((r) => control.listen(join(dir, "control.sock"), r));
  });
  afterAll(async () => {
    for (const s of [proxy, open]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    await new Promise((r) => control.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  /** The status line of a CONNECT through the proxy at `at`. */
  const tunnel = (at: number, target: string, auth?: string) =>
    new Promise<string>((resolve, reject) => {
      const s = connect(at, "127.0.0.1");
      let buf = "";
      s.on("data", (c) => {
        buf += c.toString();
      });
      s.on("end", () => resolve(buf.split("\r\n")[0] ?? ""));
      s.on("error", reject);
      const header = auth === undefined ? "" : `Proxy-Authorization: ${auth}\r\n`;
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${header}\r\n`);
    });
  /** The status code and phrase of a plain HTTP request through the proxy at `at`. */
  const plain = (at: number, url: string, auth?: string) =>
    new Promise<string>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: at,
        path: url,
        method: "GET",
        headers: auth === undefined ? {} : { "proxy-authorization": auth },
      });
      req.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve(`${res.statusCode} ${res.statusMessage}`));
      });
      req.on("error", reject);
      req.end();
    });

  it("answers each refusal with its reason and records it for the tagged operation", async () => {
    const auth = basic(`capybara:${TAG}`);
    expect(await tunnel(port, "denied.org:443", auth)).toBe(
      "HTTP/1.1 403 host is not on the allow list",
    );
    expect(await tunnel(port, "rebind.example.com:443", auth)).toBe(
      "HTTP/1.1 403 resolved to a private or reserved address",
    );
    expect(await tunnel(port, "fake.example.com:443", auth)).toBe(
      "HTTP/1.1 403 resolved by a fake-IP resolver and encrypted DNS did not answer",
    );
    expect(await plain(port, "http://rebind.example.com:8080/x", auth)).toBe(
      "403 resolved to a private or reserved address",
    );
    expect(await tunnel(openPort, "[::1]:22", auth)).toBe(
      "HTTP/1.1 403 address is a private or reserved address",
    );
    expect(await tunnel(openPort, "intranet:443", auth)).toBe("HTTP/1.1 403 malformed host");
    // a failed lookup is no refusal: no reason, nothing recorded
    expect(await tunnel(port, "missing.example.com:443", auth)).toMatch(/^HTTP\/1\.1 502/);
    // untagged (a device service) and foreign credentials: answered, never recorded
    expect(await tunnel(port, "untagged.org:443")).toBe(
      "HTTP/1.1 403 host is not on the allow list",
    );
    expect(await tunnel(port, "foreign.org:443", basic("someone:else"))).toBe(
      "HTTP/1.1 403 host is not on the allow list",
    );

    // the control socket hands the allowlist proxy's refusals over once
    const path = join(dir, "control.sock");
    const reply = await controlRequest(path, { op: "refusals", tag: TAG });
    expect(reply).toEqual({
      ok: true,
      refusals: [
        { host: "denied.org", port: 443, reason: "host is not on the allow list" },
        {
          host: "rebind.example.com",
          port: 443,
          reason: "resolved to a private or reserved address",
        },
        {
          host: "fake.example.com",
          port: 443,
          reason: "resolved by a fake-IP resolver and encrypted DNS did not answer",
        },
        {
          host: "rebind.example.com",
          port: 8080,
          reason: "resolved to a private or reserved address",
        },
      ],
    });
    expect(await controlRequest(path, { op: "refusals", tag: TAG })).toEqual({
      ok: true,
      refusals: [],
    });
    expect(await controlRequest(path, { op: "refusals", tag: "nope" })).toMatchObject({
      ok: false,
    });
    // the provider's report: the SDK's layers, deduped
    expect(blockedHosts(reply.refusals)).toEqual([
      { host: "denied.org", port: 443, layer: "device" },
      { host: "rebind.example.com", port: 443, layer: "address" },
      { host: "fake.example.com", port: 443, layer: "unknown" },
    ]);
    // the open-public proxy's: a closed literal and a single label are address
    expect(blockedHosts(openState.takeRefusals(TAG))).toEqual([
      { host: "[::1]", port: 22, layer: "address" },
      { host: "intranet", port: 443, layer: "address" },
    ]);
  });

  it("keeps a bounded record per operation and for a bounded number of operations", () => {
    const s = createEgressState({ mode: "open-public", log: () => {} });
    for (let i = 0; i < 100; i++) s.recordRefusal(TAG, `h${i}.example.org`, 443, "x");
    expect(s.takeRefusals(TAG)).toHaveLength(64);
    for (let i = 0; i < 300; i++)
      s.recordRefusal(i.toString(16).padStart(32, "0"), "a.org", 1, "x");
    expect(s.takeRefusals("0".repeat(32))).toEqual([]);
    expect(s.takeRefusals((299).toString(16).padStart(32, "0"))).toHaveLength(1);
    // no tag, no reason, or a host no refusal may carry: nothing
    s.recordRefusal(null, "a.org", 443, "x");
    s.recordRefusal(TAG, "a.org", 443, undefined);
    s.recordRefusal(TAG, "bad host", 443, "x");
    expect(s.takeRefusals(TAG)).toEqual([]);
  });
});

describe("blockedHosts", () => {
  it("never reports an invalid allowlist name as device; an address refusal of a host holds", () => {
    expect(
      blockedHosts([
        { host: "203.0.113.9", port: 443, reason: REFUSAL_REASONS.offList },
        { host: "a.example.org", port: 443, reason: REFUSAL_REASONS.offList },
        { host: "a.example.org", port: 80, reason: REFUSAL_REASONS.resolved },
        { host: "", port: 443, reason: "x" },
        { host: "b.example.org", port: 0, reason: "x" },
        42,
      ]),
    ).toEqual([
      { host: "203.0.113.9", port: 443, layer: "address" },
      { host: "a.example.org", port: 443, layer: "address" },
    ]);
    expect(blockedHosts(undefined)).toEqual([]);
    expect(
      blockedHosts(
        Array.from({ length: 30 }, (_, i) => ({
          host: `h${i}.example.org`,
          port: 443,
          reason: REFUSAL_REASONS.offList,
        })),
      ),
    ).toHaveLength(20);
  });
});
