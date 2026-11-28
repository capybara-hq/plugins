import { createHash } from "node:crypto";
import {
  DEVICE_REPORT_LIMITS,
  type DeviceRef,
  type DeviceReport,
  type DeviceReportLimit,
  type DeviceText,
  type SandboxHandle,
  type SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import {
  type DeviceLocalPolicySummary,
  type DeviceProjectReach,
  parseSandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { type OwnerFacts, ownerFactsOf } from "./owner-report.js";
import type { Binding, Connection, DeviceLocalStore } from "./store.js";

/** Support that admits nothing, naming why (the kernel shows the reason). */
export function closedSupport(unavailableReason: string): SandboxPermissionSupport {
  return parseSandboxPermissionSupport({
    version: 2,
    boundary: "operation",
    restricted: null,
    network: { openPublic: false, allowlist: false, perOperationHosts: false },
    outsideSandbox: false,
    background: false,
    unavailableReason,
  });
}

/** The support in a fixed key order (stored copies come back from jsonb in its own order). */
const canonicalSupport = (s: SandboxPermissionSupport) => {
  const p = parseSandboxPermissionSupport(s);
  return {
    version: p.version,
    boundary: p.boundary,
    restricted: p.restricted && {
      filesystem: p.restricted.filesystem,
      network: p.restricted.network,
      native: p.restricted.native,
      concurrentScopes: p.restricted.concurrentScopes,
    },
    network: {
      openPublic: p.network.openPublic,
      allowlist: p.network.allowlist,
      perOperationHosts: p.network.perOperationHosts,
      // absent on an older machine's attestation: left out so its revision stays the same
      ...(p.network.loopbackPorts !== undefined && { loopbackPorts: p.network.loopbackPorts }),
    },
    outsideSandbox: p.outsideSandbox,
    background: p.background,
    unavailableReason: p.unavailableReason ?? null,
  };
};

/**
 * Everything a report and the bound generation's support are made of, in a fixed shape: the
 * revision is its hash, so it moves whenever any of it moves:
 * - the owner ceiling (its sequence and revision, and the facts it gives, blocked or not: the
 *   project reach among them);
 * - the machine (its epoch moves when it is revoked or a new login's machine says hello);
 * - the device directory (mode, roots, home) and whether the machine opens loopback ports;
 * - the instance generation, its binding state, the runtime identity it was installed under (the
 *   environment fingerprint among it) and the permission support stored with it.
 * Times and connection ids are left out: a reconnect of the same machine with the same facts keeps
 * the revision, so it never invalidates what was approved. So are the shared project directories
 * (`Connection.sharedProjectRoots`): the kernel moves the device authority epoch on every new
 * revision, and which directories another connection also uses changes nothing the device may
 * do (the machine enforces it), so their change is told with the revision kept
 * ({@link reportMoved}) and the kernel stores the new report without invalidating approvals.
 */
function revisionFacts(c: Connection | null, b: Binding | null) {
  const owner = c ? ownerFactsOf(c.ownerReport) : null;
  return {
    v: 1,
    connection: c && {
      epoch: c.machineEpoch,
      mode: c.mode,
      roots: [c.roots.workspace, c.roots.skills, c.roots.tmp],
      home: c.home,
      // the support's loopback ports follow the feature; absent without it, so the revision of a
      // machine that never announced it stays what it was
      ...(c.features.includes("loopbackPorts") && { loopbackPorts: true }),
      owner: owner && {
        state: owner.state,
        sequence: owner.sequence,
        revision: owner.revision,
        outsideSandbox: owner.outsideSandbox,
        projectReach: owner.projectReach,
        network: owner.network,
        allowedDomains: [...owner.allowedDomains].sort(),
      },
    },
    binding: b && {
      generation: b.generation,
      status: b.status,
      unattested: b.unattested === true,
      runtime: b.installed && {
        runtimeHash: b.installed.runtimeIdentity.runtimeHash,
        helperHash: b.installed.runtimeIdentity.helperHash,
        imageFingerprint: b.installed.runtimeIdentity.imageFingerprint,
      },
      support: b.installed && canonicalSupport(b.installed.permissionSupport),
    },
  };
}

/** The report revision of a device's rows (a sha256, hex). */
export const revisionOf = (c: Connection | null, b: Binding | null): string =>
  createHash("sha256")
    .update(JSON.stringify(revisionFacts(c, b)))
    .digest("hex");

/**
 * The shared project directories a policy summary lists, sorted and without duplicates; `prev`
 * when the summary or its list was unreadable (the parser drops either to undefined). Current
 * devices always send the list (empty when none), so a missing one is malformed or from an older
 * device, which never set any.
 */
export function sharedRootsOf(
  policy: DeviceLocalPolicySummary | undefined,
  prev: readonly string[],
): string[] {
  if (policy?.sharedProjectRoots === undefined) return [...prev];
  return [...new Set(policy.sharedProjectRoots)].sort();
}

const sameRoots = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((r, i) => r === b[i]);

/**
 * Whether the report of the rows moved between `before` and `after`: its revision, or the shown
 * shared project directories (left out of the revision, {@link revisionFacts}). The kernel is told
 * (`ctx.devices.reportChanged`) exactly when this is true.
 */
export const reportMoved = (
  before: { connection: Connection | null; binding: Binding | null },
  after: { connection: Connection | null; binding: Binding | null },
): boolean =>
  revisionOf(before.connection, before.binding) !== revisionOf(after.connection, after.binding) ||
  !sameRoots(
    before.connection?.sharedProjectRoots ?? [],
    after.connection?.sharedProjectRoots ?? [],
  );

const SHARED_LABEL: DeviceText = {
  en: "Also used by another connection on this computer",
  zh: "本机的另一个连接也在使用",
};

/**
 * The shared directories as one limit value within `DEVICE_REPORT_LIMITS.limitValueChars` in each
 * language: as many whole paths as fit, in the given (sorted) order and skipping any too long,
 * then "+N more" (zh "；另有 N 个") for the rest; when no path fits whole, the end of the shortest one.
 */
export function sharedRootsValue(roots: readonly string[]): { en: string; zh: string } {
  return {
    en: fitRoots(roots, (n) => ` +${n} more`),
    zh: fitRoots(roots, (n) => `；另有 ${n} 个`),
  };
}

/** {@link sharedRootsValue} in one language: `more(n)` names the `n` roots left out. */
function fitRoots(roots: readonly string[], more: (n: number) => string): string {
  const max = DEVICE_REPORT_LIMITS.limitValueChars;
  const rest = (n: number) => (n > 0 ? more(n) : "");
  const kept: string[] = [];
  for (const root of roots) {
    // the count assumes every later root is left out: it only shrinks as more are kept
    const value = `${[...kept, root].join(", ")}${rest(roots.length - kept.length - 1)}`;
    if (value.length <= max) kept.push(root);
  }
  if (kept.length > 0) return `${kept.join(", ")}${rest(roots.length - kept.length)}`;
  const shortest = roots.reduce<string | undefined>(
    (best, r) => (best === undefined || r.length < best.length ? r : best),
    undefined,
  );
  const left = rest(roots.length - 1);
  const chars = Array.from(shortest ?? "");
  let tail = "";
  for (let i = chars.length - 1; i >= 0; i--) {
    const next = `${chars[i]}${tail}`;
    if (`…${next}${left}`.length > max) break;
    tail = next;
  }
  return `…${tail}${left}`;
}

const hosts = (n: number): DeviceText =>
  n === 1
    ? { en: "1 allowed host", zh: "允许 1 个主机" }
    : { en: `${n} allowed hosts`, zh: `允许 ${n} 个主机` };

/**
 * The reach the device's work has on the machine: a Docker container sees only the device's
 * workspace whatever the owner set.
 */
const effectiveReach = (mode: "os" | "docker", reach: DeviceProjectReach): DeviceProjectReach =>
  mode === "docker" ? "workspace" : reach;

const READS: Record<DeviceProjectReach, DeviceText> = {
  machine: {
    en: "Reads the whole machine except secrets and other connections; writes only in the project and workspace",
    zh: "读取本机全部文件（密钥和其他连接除外）；只在项目和工作区写入",
  },
  paths: {
    en: "Reads only the project directories the machine's owner listed; writes only in the project and workspace",
    zh: "只读取本机所有者列出的项目目录；只在项目和工作区写入",
  },
  workspace: { en: "Reads and writes only the device's workspace", zh: "只读写设备的工作区" },
};

/** What the device may do on the machine: its project reach and running outside the sandbox. */
export function describeLocalDevice(c: {
  projectReach: DeviceProjectReach;
  outsideSandbox: boolean;
  mode: "os" | "docker";
}): { en: string; zh: string } {
  const reads = READS[effectiveReach(c.mode, c.projectReach)];
  const outside = c.outsideSandbox
    ? {
        en: "runs outside the sandbox only per approved call",
        zh: "仅在获批的单次调用中在沙箱外运行",
      }
    : {
        en: "the machine's owner keeps every call in the sandbox",
        zh: "本机所有者让每个调用都留在沙箱内",
      };
  return { en: `${reads.en}; ${outside.en}`, zh: `${reads.zh}；${outside.zh}` };
}

/** The description line: what the owner's ceiling lets the device do on the computer. */
function describe(c: Connection, owner: OwnerFacts): DeviceText {
  const docker = c.mode === "docker";
  if (owner.state !== "report")
    return {
      en: "The computer's owner settings are unreadable or arrived out of order, so it runs as narrowly as possible (workspace only, never outside the sandbox) until it reports them again.",
      zh: "电脑所有者的设置无法读取或报告顺序异常，在重新报告前按最窄的方式运行（只用工作区，从不在沙箱外运行）。",
    };
  const what = describeLocalDevice({
    projectReach: owner.projectReach,
    outsideSandbox: owner.outsideSandbox,
    mode: c.mode,
  });
  const net =
    owner.network === "open"
      ? { en: "the open internet", zh: "开放的互联网" }
      : hosts(owner.allowedDomains.length);
  return {
    en: `${docker ? "In a Docker container: " : ""}${what.en}; network: ${net.en}.`,
    zh: `${docker ? "在 Docker 容器中：" : ""}${what.zh}；网络：${net.zh}。`,
  };
}

const REACH_VALUE: Record<DeviceProjectReach, DeviceText> = {
  machine: { en: "machine", zh: "整台机器" },
  paths: { en: "listed directories", zh: "列出的目录" },
  workspace: { en: "workspace", zh: "工作区" },
};

const MODE_VALUE: Record<Connection["mode"], DeviceText> = {
  os: { en: "os", zh: "本机系统" },
  docker: { en: "docker", zh: "Docker 容器" },
};

const NETWORK_VALUE: Record<OwnerFacts["network"], DeviceText> = {
  open: { en: "open", zh: "开放互联网" },
  allowlist: { en: "allowlist", zh: "白名单" },
};

/** The machine's own narrowing, read only (set with `capybara-device ceiling set` there). */
function limitsOf(c: Connection, owner: OwnerFacts): DeviceReportLimit[] {
  const lines: DeviceReportLimit[] = [
    { label: { en: "Mode", zh: "模式" }, value: MODE_VALUE[c.mode] },
    {
      label: { en: "Outside the sandbox", zh: "沙箱外运行" },
      value: owner.outsideSandbox
        ? { en: "per approved call", zh: "仅限获批的单次调用" }
        : { en: "off", zh: "关闭" },
    },
    {
      label: { en: "Project reach", zh: "项目范围" },
      value: REACH_VALUE[effectiveReach(c.mode, owner.projectReach)],
    },
    { label: { en: "Network", zh: "网络" }, value: NETWORK_VALUE[owner.network] },
  ];
  if (owner.network === "allowlist")
    lines.push({
      label: { en: "Allowed hosts", zh: "允许的主机" },
      value: { en: String(owner.allowedDomains.length) },
    });
  if (c.sharedProjectRoots.length > 0)
    lines.push({ label: SHARED_LABEL, value: sharedRootsValue(c.sharedProjectRoots) });
  return lines;
}

/**
 * Who changes this connection's limits and how (`DeviceReport.changeHint`): only the machine's
 * owner, on the machine, with the connection's own device id in the command.
 */
export function localChangeHint(deviceId: string): DeviceText {
  const command =
    `capybara-device ceiling set -c ${deviceId} --outside-sandbox on|off ` +
    "--network open|allowlist --project-reach machine|paths|workspace";
  return {
    en: `Only the owner of the computer changes these limits, on that computer: ${command}`,
    zh: `只有这台电脑的所有者能在电脑上更改这些限制：${command}`,
  };
}

/**
 * The device report (`DeviceProvider.report`) from the stored rows: never a machine round trip.
 * Before the machine's first hello it says so; the revision still names the binding.
 */
export function deviceReportOf(c: Connection | null, b: Binding | null): DeviceReport {
  const revision = revisionOf(c, b);
  if (!c)
    return {
      revision,
      description: {
        en: "Waiting for the computer to connect with capybara-device.",
        zh: "等待电脑用 capybara-device 连接。",
      },
      home: null,
      limits: [],
      reset: false,
    };
  const owner = ownerFactsOf(c.ownerReport);
  return {
    revision,
    description: describe(c, owner),
    // the base of an auto-mode project's relative path on the owner's own system (OS mode)
    home: c.mode === "os" ? c.home : null,
    limits: limitsOf(c, owner),
    // the files are the machine owner's directory: the provider never resets them
    reset: false,
    changeHint: localChangeHint(c.deviceId),
  };
}

/**
 * The permission support of the instance `h` (`DeviceProvider.permissionSupport`), from stored
 * facts only (never a machine round trip): what the machine attested when it installed its
 * binding, narrowed by the owner's current ceiling. Closed when the handle is not this provider's,
 * no binding is installed or no hello is stored.
 *
 * A handle whose instance the machine will never serve again (the device's binding is another
 * generation, or the machine's last hello did not attest it: the program restarted unbound) still
 * reads the installed binding's support: the kernel records support as evidence before it uses an
 * instance and never treats a failed read as gone, so the gone answer is the provider's operations'
 * (`SandboxGoneError` before anything reaches the machine, `createDeviceLocalProvider`), on which
 * the kernel recreates the instance and binds a new generation.
 */
export function supportOf(
  h: SandboxHandle,
  c: Connection | null,
  b: Binding | null,
): SandboxPermissionSupport {
  const generation = (h as { generation?: unknown }).generation;
  if (typeof generation !== "string")
    return closedSupport("The instance handle is not a connected machine's instance");
  if (b?.status !== "installed" || !b.installed)
    return closedSupport("The instance's binding on the machine is not complete yet; retry");
  if (!c)
    return closedSupport("The machine has not said hello yet; connect it with capybara-device");
  const owner = ownerFactsOf(c.ownerReport);
  const { limitedBy: _attested, ...attested } = b.installed.permissionSupport;
  // loopback ports follow the hello feature only: a machine's own claim is never reported
  const { loopbackPorts: _claimed, ...attestedNetwork } = attested.network;
  const ownerOpen = owner.state === "report" && owner.network === "open";
  // a crossing the machine could give but the owner's ceiling (or its missing facts) keeps closed
  // names the owner, so the kernel says who changes it
  const outsideSandbox = attested.outsideSandbox && owner.outsideSandbox;
  const loopback = loopbackSupportOf(c, outsideSandbox);
  const limitedBy = {
    ...(attested.outsideSandbox && !owner.outsideSandbox && { outsideSandbox: "owner" as const }),
    ...(attested.network.openPublic && !ownerOpen && { openPublic: "owner" as const }),
    ...(loopback === "device-update" && { loopbackPorts: loopback }),
  };
  return parseSandboxPermissionSupport({
    ...attested,
    // never wider than the owner allows now (a ceiling change since the binding narrows it)
    outsideSandbox,
    network: {
      ...attestedNetwork,
      // the open public internet only while the owner's sandbox network is open (an allowlist,
      // or blocked or missing facts, narrow every command's egress on the machine)
      openPublic: attested.network.openPublic && ownerOpen,
      ...(typeof loopback === "boolean" && { loopbackPorts: loopback }),
    },
    ...(Object.keys(limitedBy).length > 0 && { limitedBy }),
  });
}

/**
 * Whether the machine opens granted loopback ports to its device services
 * (`network.loopbackPorts`), given whether a call may run outside the sandbox there now:
 * - a machine announcing the `loopbackPorts` hello feature (capybara-device announces it only on
 *   macOS in OS mode, where its service launcher applies the ports) opens them exactly while a
 *   call may run outside the sandbox (the owner's ceiling included);
 * - an OS-mode macOS machine without it runs an older capybara-device (`device-update`). The hello
 *   names no operating system, so macOS is told by the owner's home under `/Users`;
 * - any other machine never opens them: undefined, the support stays as it was before the feature.
 */
function loopbackSupportOf(
  c: Connection,
  outsideSandbox: boolean,
): boolean | "device-update" | undefined {
  if (c.features.includes("loopbackPorts")) return outsideSandbox;
  if (c.mode === "os" && c.home?.startsWith("/Users/")) return "device-update";
  return undefined;
}

/**
 * `DeviceProvider.report` over the store: the device's org is learned on the first call (a hello
 * names none); a device whose rows belong to another org reads as never connected.
 */
export async function reportFor(
  store: Pick<DeviceLocalStore, "connectionOf" | "state">,
  device: Pick<DeviceRef, "deviceId" | "orgId">,
): Promise<DeviceReport> {
  const connection = await store.connectionOf(device.deviceId, device.orgId);
  const s = await store.state(device.deviceId);
  if (!connection && s.connection) return deviceReportOf(null, null);
  return deviceReportOf(connection, s.binding);
}

/** `DeviceProvider.permissionSupport` over the store ({@link supportOf}). */
export async function supportFor(
  store: Pick<DeviceLocalStore, "state">,
  h: SandboxHandle,
): Promise<SandboxPermissionSupport> {
  const { connection, binding } = await store.state(h.id);
  return supportOf(h, connection, binding);
}
