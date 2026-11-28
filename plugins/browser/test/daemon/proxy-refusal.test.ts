import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blockedHost, blockedMessage, probeProxy, proxyRefusal } from "../../daemon/actions.js";

// The device's sandbox proxy answers a refused CONNECT with 403 and its reason as the status
// phrase (patched @anthropic-ai/sandbox-runtime 0.0.81: `rawDenied`); a proxy without reasons
// answers a bare "403 Forbidden".
let server: Server;
let proxy = "";

beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(502).end());
  server.on("connect", (req, sock) => {
    const host = (req.url ?? "").split(":")[0];
    const head =
      host === "private.test"
        ? "403 resolved to a private address"
        : host === "literal.test"
          ? "403 address is a private address"
          : host === "off.test"
            ? "403 host is not on the allow list"
            : host === "plain.test"
              ? "403 Forbidden"
              : "502 Bad Gateway";
    sock.end(`HTTP/1.1 ${head}\r\nConnection: close\r\n\r\n`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  proxy = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("the proxy's refusal layer", () => {
  it("reads a closed address from the proxy's reason, any other refusal as the device's", async () => {
    expect(await proxyRefusal(proxy, "private.test", 443)).toBe("address");
    expect(await proxyRefusal(proxy, "literal.test", 443)).toBe("address");
    expect(await proxyRefusal(proxy, "off.test", 443)).toBe("device");
    expect(await proxyRefusal(proxy, "plain.test", 443)).toBe("device");
    expect(await proxyRefusal(proxy, "gone.test", 443)).toBeNull();
    expect(await probeProxy(proxy, "private.test", 443)).toEqual({
      verdict: "refused",
      reason: "resolved to a private address",
    });
  });

  it("names the device's settings and the private addresses apart", () => {
    expect(
      blockedMessage([
        { host: "a.example", port: 443, layer: "device" },
        { host: "a.example", port: 8443, layer: "device" },
        { host: "intranet.example", port: 443, layer: "address" },
      ]),
    ).toBe(
      "The device's network settings block a.example. intranet.example resolves to a private or local address on the device, which the browser never reaches from the sandbox.",
    );
  });

  it("marks a refused loopback grant host as the loopback class, with its port", () => {
    expect(blockedHost("127.0.0.1", 3999, "address")).toEqual({
      host: "127.0.0.1",
      port: 3999,
      layer: "address",
      class: "loopback",
    });
    expect(blockedHost("[::1]", 5432, "address")).toMatchObject({ class: "loopback" });
    expect(blockedHost("localhost", 80, "device")).toEqual({
      host: "localhost",
      port: 80,
      layer: "device",
    });
    expect(blockedHost("127.0.0.2", 80, "address")).toEqual({
      host: "127.0.0.2",
      port: 80,
      layer: "address",
    });
  });

  it("says a loopback port opens only once approved for the conversation", () => {
    expect(
      blockedMessage([{ host: "127.0.0.1", port: 3999, layer: "address", class: "loopback" }]),
    ).toBe(
      "127.0.0.1:3999 is a local port on the device, which the browser reaches only after the port is approved for this conversation.",
    );
    expect(
      blockedMessage([
        { host: "localhost", port: 3000, layer: "address", class: "loopback" },
        { host: "[::1]", port: 5432, layer: "address", class: "loopback" },
      ]),
    ).toBe(
      "localhost:3000, [::1]:5432 are local ports on the device, which the browser reaches only after the port is approved for this conversation.",
    );
  });
});
