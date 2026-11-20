import { readFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { type AddressInfo, BlockList } from "node:net";
import {
  classifyAddress,
  OPEN_PUBLIC_DENIED_CIDRS,
  OPEN_PUBLIC_DENIED_CLASSES,
  SANDBOX_FAKE_IP_DNS,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLOSED_CIDRS,
  createEncryptedDns,
  dnsAnswers,
  dnsQuery,
  type EncryptedDns,
  FAKE_IP_DNS,
  FAKE_IP_REFUSAL,
  isForbiddenAddress,
  resolveTarget,
} from "../egress-proxy/proxy.mjs";

/**
 * The egress proxy's address rules follow the SDK's one table (approval-only profiles design,
 * "Open network"): the closed classes of `open-public` are `OPEN_PUBLIC_DENIED_CIDRS`, copied into
 * the dependency-free proxy and kept equal here; and a fake-IP resolver's answer (198.18.0.0/15) is
 * re-resolved through DNS-over-HTTPS (`SANDBOX_FAKE_IP_DNS`) and never dialled. No Docker.
 */

const closed = (ip: string) => OPEN_PUBLIC_DENIED_CLASSES.includes(classifyAddress(ip));

describe("closed address classes", () => {
  it("copies the SDK's closed CIDR list unchanged", () => {
    expect([...CLOSED_CIDRS]).toEqual([...OPEN_PUBLIC_DENIED_CIDRS]);
  });

  it("refuses exactly the addresses the SDK classifies closed", () => {
    const fixed = [
      "8.8.8.8",
      "1.1.1.1",
      "10.0.0.1",
      "100.64.0.1",
      "100.100.100.200",
      "127.0.0.1",
      "168.63.129.16",
      "169.254.169.254",
      "172.16.5.4",
      "192.0.0.9",
      "192.168.1.1",
      "198.18.0.5",
      "203.0.113.7",
      "224.0.0.1",
      "255.255.255.255",
      "0.1.2.3",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd00:ec2::254",
      "::ffff:10.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "64:ff9b:1::1",
      "2002:0808:0808::1",
      "2002:0a00:0001::1",
      "2001:db8::1",
      "2001::1",
      "3fff::1",
      "2606:4700:4700::1111",
      "ff02::1",
    ];
    for (const ip of fixed) expect(isForbiddenAddress(ip), ip).toBe(closed(ip));
    // a deterministic spread over both families
    let seed = 0x2545f491;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let i = 0; i < 4000; i++) {
      const v4 = [24, 16, 8, 0].map((s) => (next() >>> s) & 0xff).join(".");
      expect(isForbiddenAddress(v4), v4).toBe(closed(v4));
      const v6 = Array.from({ length: 8 }, (_, g) =>
        // bias the first group toward the special prefixes
        g === 0 && i % 4 === 0 ? (next() & 0x3fff).toString(16) : (next() & 0xffff).toString(16),
      ).join(":");
      expect(isForbiddenAddress(v6), v6).toBe(closed(v6));
    }
  });

  it("keeps the deployment's denied ranges on top, embedded IPv4 forms included", () => {
    const denied = new BlockList();
    denied.addSubnet("203.0.114.0", 24, "ipv4");
    expect(isForbiddenAddress("203.0.114.9", denied)).toBe(true);
    expect(isForbiddenAddress("::ffff:203.0.114.9", denied)).toBe(true);
    expect(isForbiddenAddress("203.0.115.9", denied)).toBe(false);
  });
});

/** A DNS response for `query` with the given records (`A` as dotted text, `AAAA` as hex groups). */
function response(query: Uint8Array, records: { type: 1 | 28; data: number[]; ttl: number }[]) {
  const q = Buffer.from(query);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length, 6);
  const answers = records.map((r) => {
    const a = Buffer.alloc(12 + r.data.length);
    a.writeUInt16BE(0xc00c, 0); // a pointer to the question's name
    a.writeUInt16BE(r.type, 2);
    a.writeUInt16BE(1, 4);
    a.writeUInt32BE(r.ttl, 6);
    a.writeUInt16BE(r.data.length, 10);
    Buffer.from(r.data).copy(a, 12);
    return a;
  });
  return Buffer.concat([header, q.subarray(12), ...answers]);
}

describe("fake-IP resolvers", () => {
  it("mirrors the SDK's SANDBOX_FAKE_IP_DNS", () => {
    expect(FAKE_IP_DNS).toEqual(SANDBOX_FAKE_IP_DNS);
  });

  it("builds RFC 8484 wire queries and reads A and AAAA answers with the smallest TTL", () => {
    const q = dnsQuery("Example.COM.", 1);
    expect(q.readUInt16BE(0)).toBe(0); // ID 0
    expect(q.readUInt16BE(2)).toBe(0x0100); // RD
    expect(dnsAnswers(response(q, [{ type: 1, data: [93, 184, 216, 34], ttl: 120 }]), 1)).toEqual({
      addresses: ["93.184.216.34"],
      ttl: 120,
    });
    const q6 = dnsQuery("example.com", 28);
    const v6 = [
      0x26, 0x06, 0x28, 0, 0x02, 0x20, 0, 1, 0x02, 0x48, 0x18, 0x93, 0x25, 0xc8, 0x19, 0x46,
    ];
    expect(
      dnsAnswers(
        response(q6, [
          { type: 28, data: v6, ttl: 90 },
          { type: 28, data: v6, ttl: 30 },
        ]),
        28,
      ),
    ).toEqual({
      addresses: ["2606:2800:220:1:248:1893:25c8:1946", "2606:2800:220:1:248:1893:25c8:1946"],
      ttl: 30,
    });
    // an error response is a failure, never an empty success
    const err = response(q, []);
    err.writeUInt16BE(0x8182, 2); // SERVFAIL
    expect(() => dnsAnswers(err, 1)).toThrow();
    expect(() => dnsAnswers(Buffer.from([1, 2, 3]), 1)).toThrow();
  });

  const fakeLookup = async (h: string) => {
    if (h === "fake.example.com" || h === "rebind.example.com" || h === "lost.example.com")
      return [{ address: "198.18.0.42" }];
    if (h === "real.example.com") return [{ address: "8.8.8.8" }];
    throw new Error("ENOTFOUND");
  };
  const doh = (answers: Record<string, string[]>) =>
    createEncryptedDns({
      fetch: async (_url: string, query: Uint8Array) => {
        const name = decodeName(query);
        const type = Buffer.from(query).readUInt16BE(query.byteLength - 4) as 1 | 28;
        const list = answers[name];
        if (!list) throw new Error("unreachable endpoint");
        const records = list
          .filter((a) => (type === 1) === !a.includes(":"))
          .map((a) => ({
            type,
            data: a.includes(":") ? [...v6Bytes(a)] : a.split(".").map(Number),
            ttl: 60,
          }));
        return response(query, records);
      },
    });
  const opts = (mode: "open-public" | "allowlist", encryptedDns: EncryptedDns) => ({
    mode,
    allowHosts: ["*.example.com"],
    testHosts: {},
    lookup: fakeLookup,
    encryptedDns,
  });

  it("re-resolves a fake-IP answer through encrypted DNS and returns the real address, in both modes", async () => {
    const e = doh({ "fake.example.com": ["93.184.216.34"] });
    expect(await resolveTarget("fake.example.com", opts("open-public", e))).toEqual([
      "93.184.216.34",
    ]);
    expect(await resolveTarget("fake.example.com", opts("allowlist", e))).toEqual([
      "93.184.216.34",
    ]);
    // an ordinary answer never goes through encrypted DNS
    expect(await resolveTarget("real.example.com", opts("open-public", e))).toEqual(["8.8.8.8"]);
  });

  it("judges the encrypted answer like any resolved address", async () => {
    const e = doh({ "rebind.example.com": ["10.0.0.1"] });
    await expect(resolveTarget("rebind.example.com", opts("open-public", e))).rejects.toMatchObject(
      { status: 403 },
    );
  });

  it("refuses with the fake-IP reason when encrypted DNS fails, never dialling the fake address", async () => {
    const e = doh({});
    await expect(resolveTarget("lost.example.com", opts("open-public", e))).rejects.toMatchObject({
      status: 403,
      message: FAKE_IP_REFUSAL,
    });
  });

  it("caches an answer only when both queries succeeded, for its TTL capped at the SDK's limit", async () => {
    let calls = 0;
    let now = 1_000_000;
    const e = createEncryptedDns({
      clock: () => now,
      fetch: async (_url: string, query: Uint8Array) => {
        calls++;
        const type = Buffer.from(query).readUInt16BE(query.byteLength - 4) as 1 | 28;
        return response(
          query,
          type === 1 ? [{ type: 1, data: [93, 184, 216, 34], ttl: 100_000 }] : [],
        );
      },
    });
    expect(await e.resolve("a.example.com")).toEqual(["93.184.216.34"]);
    expect(calls).toBe(2);
    expect(await e.resolve("A.example.com.")).toEqual(["93.184.216.34"]);
    expect(calls).toBe(2);
    now += SANDBOX_FAKE_IP_DNS.cacheTtlCapSeconds * 1000 + 1;
    await e.resolve("a.example.com");
    expect(calls).toBe(4);
    // one failed query: no cache entry, and the next endpoint is tried
    let failAaaa = true;
    const urls: string[] = [];
    const f = createEncryptedDns({
      fetch: async (url: string, query: Uint8Array) => {
        urls.push(url);
        const type = Buffer.from(query).readUInt16BE(query.byteLength - 4);
        if (type === 28 && failAaaa) {
          failAaaa = false;
          throw new Error("stalled");
        }
        return response(query, type === 1 ? [{ type: 1, data: [1, 2, 3, 4], ttl: 60 }] : []);
      },
    });
    expect(await f.resolve("b.example.com")).toEqual(["1.2.3.4"]);
    expect(urls.slice(0, 2)).toEqual([
      SANDBOX_FAKE_IP_DNS.endpoints[0],
      SANDBOX_FAKE_IP_DNS.endpoints[0],
    ]);
    expect(urls[2]).toBe(SANDBOX_FAKE_IP_DNS.endpoints[1]);
  });

  it("bounds the cache to the SDK's name limit, oldest first", async () => {
    const e = createEncryptedDns({
      fetch: async (_url: string, query: Uint8Array) => response(query, []),
    });
    for (let i = 0; i <= SANDBOX_FAKE_IP_DNS.cacheMaxNames; i++)
      await e.resolve(`n${i}.example.com`);
    expect(e.cacheSize()).toBe(SANDBOX_FAKE_IP_DNS.cacheMaxNames);
  });

  it("gives every endpoint a share of one deadline per name", async () => {
    const budgets: number[] = [];
    let now = 0;
    const e = createEncryptedDns({
      clock: () => now,
      // every endpoint stalls for its whole share
      fetch: (_url: string, _query: Uint8Array, timeoutMs: number) => {
        budgets.push(timeoutMs);
        now += timeoutMs;
        return Promise.reject(new Error("stalled"));
      },
    });
    await expect(e.resolve("c.example.com")).rejects.toThrow(FAKE_IP_REFUSAL);
    const n = SANDBOX_FAKE_IP_DNS.endpoints.length;
    expect(budgets).toEqual(Array(n).fill(SANDBOX_FAKE_IP_DNS.timeoutMs / n));
    expect(now).toBe(SANDBOX_FAKE_IP_DNS.timeoutMs);
  });

  describe("over HTTPS", () => {
    // a self-signed certificate for the IP 127.0.0.1 (IP SAN), checked like the real endpoints'
    const key = readFileSync(new URL("./fixtures/doh-key.pem", import.meta.url));
    const cert = readFileSync(new URL("./fixtures/doh-cert.pem", import.meta.url));
    let server: Server;
    let endpoint: string;
    beforeAll(async () => {
      server = createHttpsServer({ key, cert }, (req, res) => {
        const dns = new URL(req.url ?? "/", "https://x").searchParams.get("dns") ?? "";
        const query = Buffer.from(dns, "base64url");
        const type = query.readUInt16BE(query.byteLength - 4);
        res.writeHead(200, { "content-type": "application/dns-message" });
        res.end(
          response(query, type === 1 ? [{ type: 1, data: [93, 184, 216, 34], ttl: 60 }] : []),
        );
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}/dns-query`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("queries by GET in wire format and verifies TLS against the endpoint's IP SAN", async () => {
      const trusted = createEncryptedDns({ endpoints: [endpoint], ca: cert });
      expect(await trusted.resolve("example.com")).toEqual(["93.184.216.34"]);
      // the default trust store does not know the test certificate: refused
      const untrusted = createEncryptedDns({ endpoints: [endpoint] });
      await expect(untrusted.resolve("example.com")).rejects.toThrow(FAKE_IP_REFUSAL);
    });
  });
});

function decodeName(query: Uint8Array): string {
  const b = Buffer.from(query);
  const labels: string[] = [];
  let at = 12;
  while (b[at] !== 0) {
    const n = b[at] as number;
    labels.push(b.subarray(at + 1, at + 1 + n).toString("ascii"));
    at += 1 + n;
  }
  return labels.join(".");
}

function v6Bytes(ip: string): Buffer {
  const halves = ip.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  const out = Buffer.alloc(16);
  for (const [i, g] of groups.entries()) out.writeUInt16BE(Number.parseInt(g, 16), i * 2);
  return out;
}
