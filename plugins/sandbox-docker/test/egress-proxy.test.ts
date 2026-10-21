import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEgressProxy, hostAllowed, isForbiddenAddress } from "../egress-proxy/proxy.mjs";

/** 出站代理（不需要 Docker）：主机名白名单、解析后的 IP 检查（挡 DNS 重绑定）、HTTP 与 CONNECT。 */

describe("isForbiddenAddress", () => {
  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.5.4",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.254",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:a00:1::1",
    "not-an-ip",
  ])("%s is forbidden", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "%s is allowed",
    (ip) => {
      expect(isForbiddenAddress(ip)).toBe(false);
    },
  );
});

describe("hostAllowed", () => {
  const allow = ["github.com", "*.example.com"];
  it("matches exact names and subdomains of wildcards (not the apex)", () => {
    expect(hostAllowed("github.com", allow)).toBe(true);
    expect(hostAllowed("GitHub.com.", allow)).toBe(true);
    expect(hostAllowed("api.github.com", allow)).toBe(false);
    expect(hostAllowed("a.example.com", allow)).toBe(true);
    expect(hostAllowed("a.b.example.com", allow)).toBe(true);
    expect(hostAllowed("example.com", allow)).toBe(false);
    expect(hostAllowed("badexample.com", allow)).toBe(false);
    expect(hostAllowed("github.com.evil.org", allow)).toBe(false);
  });
  it("never matches IP literals", () => {
    expect(hostAllowed("10.0.0.1", ["*.0.0.1"])).toBe(false);
    expect(hostAllowed("[::1]", allow)).toBe(false);
  });
});

describe("proxy server", () => {
  let target: Server;
  let targetPort: number;
  let proxy: Server;
  let proxyPort: number;
  // 假 DNS：rebind.example.com → 10.0.0.1（DNS 重绑定），public.example.com → 公网地址（连不上也无所谓）
  const lookup = async (h: string) => {
    if (h === "rebind.example.com") return [{ address: "10.0.0.1" }];
    if (h === "mixed.example.com") return [{ address: "8.8.8.8" }, { address: "127.0.0.1" }];
    if (h === "v6.example.com") return [{ address: "::ffff:169.254.169.254" }];
    throw new Error("ENOTFOUND");
  };

  beforeAll(async () => {
    target = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`hello from target ${req.method} ${req.url} host=${req.headers.host}`);
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    targetPort = (target.address() as AddressInfo).port;
    proxy = createEgressProxy({
      allowHosts: ["allowed.example.com", "*.example.com"],
      // 仅测试：allowed.example.com 固定到本机的目标服务
      testHosts: { "allowed.example.com": "127.0.0.1" },
      lookup,
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((r) => proxy?.close(r));
    await new Promise((r) => target?.close(r));
  });

  /** 经代理发 HTTP 请求（绝对 URL）。 */
  const viaProxy = (url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: proxyPort, path: url, method: "GET" });
      req.on("response", (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

  /** 发 CONNECT，返回状态行与隧道里收到的数据（隧道建立后发一个 HTTP 请求）。 */
  const tunnel = (hostPort: string) =>
    new Promise<string>((resolve, reject) => {
      const s = connect(proxyPort, "127.0.0.1");
      let buf = "";
      let sent = false;
      s.on("data", (c) => {
        buf += c.toString();
        if (!sent && buf.startsWith("HTTP/1.1 200")) {
          sent = true;
          s.write(`GET /t HTTP/1.1\r\nHost: ${hostPort}\r\nConnection: close\r\n\r\n`);
        }
      });
      s.on("end", () => resolve(buf));
      s.on("error", reject);
      s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`);
    });

  it("forwards plain HTTP to an allowed host", async () => {
    const r = await viaProxy(`http://allowed.example.com:${targetPort}/x?y=1`);
    expect(r.status).toBe(200);
    expect(r.body).toBe(`hello from target GET /x?y=1 host=allowed.example.com:${targetPort}`);
  });

  it("refuses hosts not on the allowlist", async () => {
    const r = await viaProxy(`http://denied.org:${targetPort}/`);
    expect(r.status).toBe(403);
    expect(r.body).toContain("blocked by the sandbox egress allowlist");
  });

  it("refuses IP literals", async () => {
    const r = await viaProxy(`http://127.0.0.1:${targetPort}/`);
    expect(r.status).toBe(403);
  });

  it.each(["rebind.example.com", "mixed.example.com", "v6.example.com"])(
    "refuses allowed names resolving to private addresses (HTTP): %s",
    async (host) => {
      const r = await viaProxy(`http://${host}:${targetPort}/`);
      expect(r.status).toBe(403);
      expect(r.body).toContain("private or reserved address");
    },
  );

  it("tunnels CONNECT to an allowed host", async () => {
    const out = await tunnel(`allowed.example.com:${targetPort}`);
    expect(out).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(out).toContain("hello from target GET /t");
  });

  it("refuses CONNECT to private resolutions and unlisted hosts", async () => {
    expect(await tunnel(`rebind.example.com:${targetPort}`)).toMatch(/^HTTP\/1\.1 403/);
    expect(await tunnel(`denied.org:443`)).toMatch(/^HTTP\/1\.1 403/);
    expect(await tunnel(`127.0.0.1:${targetPort}`)).toMatch(/^HTTP\/1\.1 403/);
  });

  it("rejects non-proxy requests", async () => {
    const r = await viaProxy("/not-absolute");
    expect(r.status).toBe(400);
  });
});
