// Capybara 沙箱出站代理：每个 allowlist 沙箱一个，跑在只有它与沙箱的内部网络上，另一只脚接出站网络。
//
// - 只放行 ALLOW_HOSTS（JSON 字符串数组，规则同 plugin-sdk 的 validateAllowHost）里的主机名：
//   精确匹配，或 `*.example.com` 匹配它的任意子域（不含 example.com 本身）；
// - 先解析，再检查**解析出的每一个 IP**：私有、回环、链路本地（含 169.254.169.254 元数据）、CGNAT、ULA、
//   未指定、组播、保留与文档地址一律拒绝（挡 DNS 重绑定，如 10.0.0.1.nip.io），然后直连检查过的那个 IP，
//   不再二次解析；
// - HTTPS 走 CONNECT 隧道（默认只放行 443、80 端口，ALLOW_CONNECT_PORTS 逗号分隔可改），HTTP 走绝对 URL 转发；
//   IP 字面量主机名永远不在白名单里；第一个地址连不上时依次试其余检查过的地址；
// - 仅测试：CAPYBARA_EGRESS_TEST_HOSTS（JSON 对象 主机名 → IP）把主机名固定解析到给定 IP 并豁免私有地址
//   检查（仍要在白名单里）。插件的部署配置设不了它，只有直接调用 createDockerSandbox 的测试能设。
//
// 无依赖，Node ≥ 22。错误文本给模型看（经 curl / pip 等输出），用英文。
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { BlockList, connect, isIP } from "node:net";

// 本文件跑在出站代理容器里（不在内核进程里），下面几个模块级对象都是启动后只读的常量表。
// capybara:allow-module-state 只读常量表（出站代理容器内，不在内核进程里）
const BLOCKED_V4 = [
  ["0.0.0.0", 8], // 未指定 / 本网
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // 链路本地（含云元数据 169.254.169.254）
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // 组播
  ["240.0.0.0", 4], // 保留与广播
];
// capybara:allow-module-state 只读常量表（出站代理容器内，不在内核进程里）
const BLOCKED_V6 = [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7], // ULA
  ["fe80::", 10], // 链路本地
  ["fec0::", 10],
  ["ff00::", 8], // 组播
];

// capybara:allow-module-state 启动时建好的只读地址表（出站代理容器内，不在内核进程里）
const blocked = new BlockList();
for (const [a, p] of BLOCKED_V4) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of BLOCKED_V6) blocked.addSubnet(a, p, "ipv6");

/** 十六位一组的 IPv6 → 8 个数字；解析失败返回 null。 */
function v6Groups(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // 末尾的点分 IPv4（::ffff:1.2.3.4）
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const b = m[2].split(".").map(Number);
    s = `${m[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const v4Of = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * 解析出的 IP 是否禁止连接。内嵌 IPv4 的 IPv6（IPv4 映射 ::ffff:0:0/96、IPv4 兼容 ::/96、NAT64 64:ff9b::/96、
 * 6to4 2002::/16）按内嵌的 IPv4 判断；不认识的格式一律禁止。
 */
export function isForbiddenAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family !== 6) return true;
  const g = v6Groups(ip);
  if (g === null) return true;
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return isForbiddenAddress(v4Of(g[6], g[7]));
  if (zeros(0, 6) && (g[6] !== 0 || g[7] > 1)) return isForbiddenAddress(v4Of(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b) return isForbiddenAddress(v4Of(g[6], g[7]));
  if (g[0] === 0x2002) return isForbiddenAddress(v4Of(g[1], g[2]));
  const canonical = g.map((x) => x.toString(16)).join(":");
  return blocked.check(canonical, "ipv6");
}

/** 规范化主机名：小写、去掉末尾的点与 IPv6 方括号。 */
export function normalizeHost(host) {
  let h = String(host).trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** 主机名是否在白名单里：精确匹配，或 `*.x` 匹配 x 的任意子域（不含 x 本身）。IP 字面量永远不匹配。 */
export function hostAllowed(host, allowHosts) {
  const h = normalizeHost(host);
  if (h === "" || isIP(h) !== 0) return false;
  return allowHosts.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
}

class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 决定能连哪些 IP：白名单检查 → 解析 → 每个地址都不能是禁止地址。返回检查过的全部地址（按解析顺序）。
 * @param {{ allowHosts: string[]; testHosts: Record<string, string>; lookup: (h: string) => Promise<{ address: string }[]> }} opts
 */
export async function resolveTarget(host, opts) {
  const h = normalizeHost(host);
  if (!hostAllowed(h, opts.allowHosts)) {
    throw new Refused(
      403,
      `Outbound access to ${h} is blocked by the sandbox egress allowlist. Allowed hosts: ${opts.allowHosts.join(", ") || "(none)"}.`,
    );
  }
  const pinned = Object.hasOwn(opts.testHosts, h) ? opts.testHosts[h] : undefined;
  if (pinned !== undefined) return [pinned];
  let addrs;
  try {
    addrs = await opts.lookup(h);
  } catch {
    throw new Refused(502, `Cannot resolve ${h}.`);
  }
  if (addrs.length === 0) throw new Refused(502, `Cannot resolve ${h}.`);
  if (addrs.some((a) => isForbiddenAddress(a.address))) {
    throw new Refused(
      403,
      `Outbound access to ${h} is blocked: it resolves to a private or reserved address.`,
    );
  }
  return addrs.map((a) => a.address);
}

/** 依次连接检查过的地址，第一个连上的返回；都连不上抛最后的错误。 */
export function connectAny(ips, port) {
  return new Promise((resolve, reject) => {
    const attempt = (i, lastError) => {
      if (i >= ips.length) {
        reject(lastError ?? new Error("no address"));
        return;
      }
      const s = connect({ host: ips[i], port });
      s.once("connect", () => {
        s.removeAllListeners("error");
        resolve(s);
      });
      s.once("error", (e) => {
        s.destroy();
        attempt(i + 1, e);
      });
    };
    attempt(0, undefined);
  });
}

// capybara:allow-module-state 只读常量表（出站代理容器内，不在内核进程里）
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 去掉逐跳头（含 Connection 里列出的）。 */
function forwardHeaders(headers) {
  const listed = String(headers.connection ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k) && !listed.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/** `host:port`（含 `[v6]:port`）→ [host, port]。 */
function splitHostPort(s) {
  const m = String(s).match(/^\[?([^\]]*?)\]?:(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? [m[1], port] : null;
}

const defaultLookup = (h) => dnsLookup(h, { all: true, verbatim: true });

/** CONNECT 默认只放行这些端口（ALLOW_CONNECT_PORTS 可改）。 */
// capybara:allow-module-state 只读常量（出站代理容器内，不在内核进程里）
const DEFAULT_CONNECT_PORTS = [443, 80];

/**
 * 建代理服务器（未监听）。
 * @param {{ allowHosts: string[]; testHosts?: Record<string, string>; connectPorts?: number[]; lookup?: (h: string) => Promise<{ address: string }[]> }} cfg
 */
export function createEgressProxy(cfg) {
  const opts = {
    allowHosts: cfg.allowHosts.map((h) => h.toLowerCase()),
    testHosts: cfg.testHosts ?? {},
    lookup: cfg.lookup ?? defaultLookup,
  };
  const connectPorts = cfg.connectPorts ?? DEFAULT_CONNECT_PORTS;
  const refuse = (res, e) => {
    const status = e instanceof Refused ? e.status : 502;
    const msg = e instanceof Refused ? e.message : "Upstream connection failed.";
    if (!res.headersSent)
      res.writeHead(status, { "content-type": "text/plain", connection: "close" });
    res.end(`${msg}\n`);
  };

  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    let url;
    try {
      url = new URL(req.url);
    } catch {
      refuse(res, new Refused(400, "This is an HTTP proxy: request an absolute http:// URL."));
      return;
    }
    if (url.protocol !== "http:") {
      refuse(res, new Refused(400, "Only http:// URLs can be proxied; use CONNECT for https."));
      return;
    }
    let sock;
    try {
      const ips = await resolveTarget(url.hostname, opts);
      sock = await connectAny(ips, url.port === "" ? 80 : Number(url.port)).catch(() => {
        throw new Refused(502, `Cannot connect to ${url.host}.`);
      });
    } catch (e) {
      refuse(res, e);
      return;
    }
    const headers = forwardHeaders(req.headers);
    headers.host = url.host;
    // 每个请求一条上游连接（不进连接池，不会被别的主机复用）
    headers.connection = "close";
    const up = httpRequest({
      createConnection: () => sock,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
    });
    up.on("response", (r) => {
      res.writeHead(r.statusCode ?? 502, forwardHeaders(r.headers));
      r.pipe(res);
    });
    up.on("error", (e) => refuse(res, e));
    req.on("aborted", () => up.destroy());
    req.pipe(up);
  });

  server.on("connect", async (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const hp = splitHostPort(req.url);
    const fail = (status, msg) => {
      socket.end(
        `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${msg}\n`,
      );
    };
    if (hp === null) {
      fail(400, "CONNECT needs host:port.");
      return;
    }
    if (!connectPorts.includes(hp[1])) {
      fail(
        403,
        `CONNECT to port ${hp[1]} is not allowed (allowed ports: ${connectPorts.join(", ")}).`,
      );
      return;
    }
    let ips;
    try {
      ips = await resolveTarget(hp[0], opts);
    } catch (e) {
      fail(e instanceof Refused ? e.status : 502, e instanceof Refused ? e.message : "Failed.");
      return;
    }
    let up;
    try {
      up = await connectAny(ips, hp[1]);
    } catch {
      fail(502, `Cannot connect to ${hp[0]}:${hp[1]}.`);
      return;
    }
    up.on("error", () => socket.destroy());
    socket.on("close", () => up.destroy());
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  return server;
}

/** 容器入口：从环境变量读配置并监听（PORT，默认 3128）。 */
export function main(env = process.env) {
  const allowHosts = JSON.parse(env.ALLOW_HOSTS ?? "[]");
  const testHosts = JSON.parse(env.CAPYBARA_EGRESS_TEST_HOSTS ?? "{}");
  const port = Number(env.PORT ?? 3128);
  const connectPorts = env.ALLOW_CONNECT_PORTS
    ? env.ALLOW_CONNECT_PORTS.split(",").map((p) => Number(p.trim()))
    : undefined;
  const server = createEgressProxy({ allowHosts, testHosts, connectPorts });
  server.listen(port, () => {
    console.log(`egress proxy listening on ${port}; allow: ${allowHosts.join(", ") || "(none)"}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
