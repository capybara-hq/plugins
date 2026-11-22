import { createHash } from "node:crypto";
import type {
  DeviceRef,
  DeviceReport,
  DeviceReportLimit,
  DeviceText,
  SandboxHandle,
  SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import { parseSandboxPermissionSupport } from "@capybara-hq/plugin-sdk/device-protocol";
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
    },
    outsideSandbox: p.outsideSandbox,
    background: p.background,
    unavailableReason: p.unavailableReason ?? null,
  };
};

/**
 * Everything a report and the bound generation's support are made of, in a fixed shape: the
 * revision is its hash, so it moves whenever any of it moves:
 * - the owner ceiling (its sequence and revision, and the facts it gives, blocked or not);
 * - the machine (its epoch moves when it is revoked or a new login's machine says hello);
 * - the device directory (mode, roots, home);
 * - the instance generation, its binding state, the runtime identity it was installed under (the
 *   environment fingerprint among it) and the permission support stored with it.
 * Times and connection ids are left out: a reconnect of the same machine with the same facts keeps
 * the revision, so it never invalidates what was approved.
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
      owner: owner && {
        state: owner.state,
        sequence: owner.sequence,
        revision: owner.revision,
        outsideSandbox: owner.outsideSandbox,
        reach: owner.restrictedProjectReach,
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

const hosts = (n: number): DeviceText =>
  n === 1
    ? { en: "1 allowed host", zh: "允许 1 个主机" }
    : { en: `${n} allowed hosts`, zh: `允许 ${n} 个主机` };

/** The description line: what the owner's ceiling lets the device do on the computer. */
function describe(c: Connection, owner: OwnerFacts): DeviceText {
  const docker = c.mode === "docker";
  if (owner.state !== "report")
    return {
      en: "The computer's owner settings are unreadable or arrived out of order, so it runs as narrowly as possible (workspace only, never outside the sandbox) until it reports them again.",
      zh: "电脑主人的设置无法读取或报告顺序异常，在重新报告前按最窄的方式运行（只用工作区，从不在沙箱外运行）。",
    };
  const reach =
    owner.restrictedProjectReach === "os-user"
      ? {
          en: "Reads the whole computer except secrets; writes only in the project",
          zh: "读取整台电脑（密钥除外），只在项目中写入",
        }
      : { en: "Reads and writes only in its workspace", zh: "只在工作区内读写" };
  const outside = owner.outsideSandbox
    ? {
        en: "runs outside the sandbox only per approved call",
        zh: "仅对批准的单次调用在沙箱外运行",
      }
    : { en: "never runs outside the sandbox", zh: "从不在沙箱外运行" };
  const net =
    owner.network === "open"
      ? { en: "the open internet", zh: "开放的互联网" }
      : hosts(owner.allowedDomains.length);
  return {
    en: `${docker ? "In a Docker container: " : ""}${reach.en}; ${outside.en}; network: ${net.en}.`,
    zh: `${docker ? "在 Docker 容器中：" : ""}${reach.zh}；${outside.zh}；网络：${net.zh}。`,
  };
}

/** The machine's own narrowing, read only (set with `capybara-device ceiling set` there). */
function limitsOf(c: Connection, owner: OwnerFacts): DeviceReportLimit[] {
  const lines: DeviceReportLimit[] = [
    { label: { en: "Mode", zh: "模式" }, value: c.mode },
    {
      label: { en: "Outside the sandbox", zh: "沙箱外运行" },
      value: owner.outsideSandbox ? "per approved call" : "off",
    },
    {
      label: { en: "Project reach", zh: "项目范围" },
      value: owner.restrictedProjectReach === "os-user" ? "machine" : "workspace",
    },
    { label: { en: "Network", zh: "网络" }, value: owner.network },
  ];
  if (owner.network === "allowlist")
    lines.push({
      label: { en: "Allowed hosts", zh: "允许的主机" },
      value: String(owner.allowedDomains.length),
    });
  return lines;
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
  const attested = b.installed.permissionSupport;
  return parseSandboxPermissionSupport({
    ...attested,
    // never wider than the owner allows now (a ceiling change since the binding narrows it)
    outsideSandbox: attested.outsideSandbox && owner.outsideSandbox,
    // the open public internet only while the owner's sandbox network is open (an allowlist, or
    // blocked or missing facts, narrow every command's egress on the machine)
    network: {
      ...attested.network,
      openPublic:
        attested.network.openPublic && owner.state === "report" && owner.network === "open",
    },
  });
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
