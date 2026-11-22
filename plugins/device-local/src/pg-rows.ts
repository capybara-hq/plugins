import {
  type DeviceFeature,
  type DeviceRuntimeIdentity,
  parseOwnerCeilingReport,
  parseSandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { type Kysely, sql, type Transaction } from "kysely";
import { storedOwnerReportOf } from "./owner-report.js";
import type { Binding, Connection, DeviceRows, DeviceState, InstalledBinding } from "./store.js";

// biome-ignore lint/suspicious/noExplicitAny: ctx.db is an untyped Kysely switched to the schema
type Db = Kysely<any> | Transaction<any>;
type Row = Record<string, unknown>;

const HASH = /^[a-f0-9]{64}$/;
// capybara:allow-module-state a frozen list of the protocol's known features, never written
const FEATURES: readonly DeviceFeature[] = Object.freeze(["networkReport", "projects"]);

/** Values a json column gives back: pg parses jsonb itself, a string is parsed here. */
const json = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

/** A stored runtime identity, or null when it is not a complete one. */
function identityOf(v: unknown): DeviceRuntimeIdentity | null {
  const o = json(v) as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const { runtimeHash, helperHash, imageFingerprint, instanceGeneration } = o;
  if (
    typeof runtimeHash !== "string" ||
    !HASH.test(runtimeHash) ||
    typeof helperHash !== "string" ||
    !HASH.test(helperHash) ||
    typeof imageFingerprint !== "string" ||
    !HASH.test(imageFingerprint) ||
    typeof instanceGeneration !== "string"
  )
    return null;
  return { runtimeHash, helperHash, imageFingerprint, instanceGeneration };
}

/** The installed facts of a row, or undefined when any of them is unreadable (fail closed). */
function installedOf(r: Row): InstalledBinding | undefined {
  const runtimeIdentity = identityOf(r.runtime_identity);
  if (!runtimeIdentity) return undefined;
  try {
    return {
      runtimeIdentity,
      permissionSupport: parseSandboxPermissionSupport(json(r.permission_support)),
      ownerCeiling: parseOwnerCeilingReport(json(r.owner_ceiling)),
    };
  } catch {
    return undefined;
  }
}

function bindingOf(r: Row | undefined): Binding | null {
  if (!r) return null;
  const installed = r.status === "installed" ? installedOf(r) : undefined;
  return {
    deviceId: String(r.device_id),
    instanceId: String(r.instance_id),
    generation: String(r.generation),
    bindingId: String(r.binding_id),
    previousGeneration: r.previous_generation === null ? null : String(r.previous_generation),
    // an installed row whose facts are unreadable admits nothing until a binding answer again
    status: installed ? "installed" : "awaiting-device",
    ...(installed && { installed }),
    ...(installed && r.unattested === true && { unattested: true as const }),
  };
}

/** Support that admits nothing, for a stored hello support that no longer parses. */
const UNREADABLE_SUPPORT = parseSandboxPermissionSupport({
  version: 2,
  boundary: "operation",
  restricted: null,
  network: { openPublic: false, allowlist: false, perOperationHosts: false },
  outsideSandbox: false,
  background: false,
  unavailableReason:
    "The stored hello is unreadable; the machine reports it again when it reconnects",
});

function connectionOf(r: Row | undefined): Connection | null {
  if (!r) return null;
  const roots = json(r.roots) as Record<string, unknown> | null;
  if (
    !roots ||
    typeof roots.workspace !== "string" ||
    typeof roots.skills !== "string" ||
    typeof roots.tmp !== "string" ||
    (r.mode !== "os" && r.mode !== "docker") ||
    typeof r.machine_id !== "string" ||
    typeof r.connection_id !== "string"
  )
    return null;
  let permissionSupport = UNREADABLE_SUPPORT;
  try {
    permissionSupport = parseSandboxPermissionSupport(json(r.permission_support));
  } catch {
    // kept closed
  }
  const features = Array.isArray(r.features) ? r.features : [];
  return {
    deviceId: String(r.device_id),
    orgId: typeof r.org_id === "string" ? r.org_id : null,
    machineId: r.machine_id,
    connectionId: r.connection_id,
    machineEpoch: Number(r.machine_epoch),
    mode: r.mode,
    roots: { workspace: roots.workspace, skills: roots.skills, tmp: roots.tmp },
    home: typeof r.home === "string" ? r.home : null,
    sessionIsolation: r.session_isolation === true,
    features: FEATURES.filter((f) => features.includes(f)),
    permissionSupport,
    ownerReport: storedOwnerReportOf(json(r.owner_report)),
    instanceGeneration: typeof r.instance_generation === "string" ? r.instance_generation : null,
    runtimeIdentity: identityOf(r.runtime_identity),
  };
}

async function readIn(db: Db, deviceId: string): Promise<DeviceState> {
  const [c, b] = await Promise.all([
    db.selectFrom("connections").selectAll().where("device_id", "=", deviceId).executeTakeFirst(),
    db.selectFrom("bindings").selectAll().where("device_id", "=", deviceId).executeTakeFirst(),
  ]);
  return { connection: connectionOf(c), binding: bindingOf(b) };
}

async function writeConnection(db: Db, c: Connection): Promise<void> {
  const values = {
    device_id: c.deviceId,
    org_id: c.orgId,
    machine_id: c.machineId,
    connection_id: c.connectionId,
    machine_epoch: c.machineEpoch,
    mode: c.mode,
    roots: JSON.stringify(c.roots),
    home: c.home,
    session_isolation: c.sessionIsolation,
    features: c.features,
    permission_support: JSON.stringify(c.permissionSupport),
    owner_report: c.ownerReport === null ? null : JSON.stringify(c.ownerReport),
    instance_generation: c.instanceGeneration,
    runtime_identity: c.runtimeIdentity === null ? null : JSON.stringify(c.runtimeIdentity),
    updated_at: sql`now()`,
  };
  const { device_id: _key, org_id: _org, ...update } = values;
  await db
    .insertInto("connections")
    .values(values)
    .onConflict((oc) =>
      oc.column("device_id").doUpdateSet({
        ...update,
        // the org is learned once (connectionOf) and never moves
        org_id: sql`coalesce(connections.org_id, excluded.org_id)`,
      }),
    )
    .execute();
}

async function writeBinding(db: Db, b: Binding): Promise<void> {
  const values = {
    device_id: b.deviceId,
    instance_id: b.instanceId,
    generation: b.generation,
    binding_id: b.bindingId,
    previous_generation: b.previousGeneration,
    status: b.status,
    runtime_identity: b.installed ? JSON.stringify(b.installed.runtimeIdentity) : null,
    permission_support: b.installed ? JSON.stringify(b.installed.permissionSupport) : null,
    owner_ceiling: b.installed ? JSON.stringify(b.installed.ownerCeiling) : null,
    unattested: b.unattested === true,
    updated_at: sql`now()`,
  };
  const { device_id: _key, ...update } = values;
  await db
    .insertInto("bindings")
    .values(values)
    .onConflict((oc) => oc.column("device_id").doUpdateSet(update))
    .execute();
}

/** One device's writers, serialized for the transaction (released at its end). */
const lockDevice = (trx: Db, deviceId: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${`device-local:${deviceId}`}, 0))`.execute(
    trx,
  );

/**
 * {@link DeviceRows} over the plugin's schema (`ctx.db`, already switched to
 * `plugin_device_local`): every row is keyed by device id; a change takes a transaction-scoped
 * advisory lock on the device (no lock outlives its transaction, nothing is held in memory).
 */
// biome-ignore lint/suspicious/noExplicitAny: ctx.db is an untyped Kysely switched to the schema
export function pgRows(db: Kysely<any>): DeviceRows {
  return {
    read: (deviceId) => readIn(db, deviceId),
    change: (deviceId, fn) =>
      db.transaction().execute(async (trx) => {
        await lockDevice(trx, deviceId);
        const c = fn(await readIn(trx, deviceId));
        if (c.connection) await writeConnection(trx, c.connection);
        if (c.binding) await writeBinding(trx, c.binding);
        return c.result;
      }),
    async connectionOf(deviceId, orgId) {
      await db
        .updateTable("connections")
        .set({ org_id: orgId })
        .where("device_id", "=", deviceId)
        .where("org_id", "is", null)
        .execute();
      const r = await db
        .selectFrom("connections")
        .selectAll()
        .where("device_id", "=", deviceId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      return connectionOf(r);
    },
    forget: (deviceId) =>
      db.transaction().execute(async (trx) => {
        await lockDevice(trx, deviceId);
        await trx.deleteFrom("connections").where("device_id", "=", deviceId).execute();
        await trx.deleteFrom("bindings").where("device_id", "=", deviceId).execute();
      }),
  };
}
