import { fileURLToPath } from "node:url";
import { DEVICE_DIAL_IN_PROTOCOL } from "@capybara-hq/plugin-sdk/device-protocol";
import {
  createDb,
  createLocalAccount,
  createOrg,
  FakeDialInMachine,
  type KernelRequest,
  type KernelSchemaDb,
  kernelDb,
  login,
  signInFakeMachine,
  startTestKernel,
  startTestPostgres,
  startTestRedis,
  TEST_PASSWORD,
  type TestContainer,
  type TestKernel,
  testKernelConfig,
  waitFor,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgRows, revisionOf, storeOver } from "../src/index.js";
import { OWNER_CEILING, ROOTS, SUPPORT } from "./fakes.js";

/**
 * device-local in one in-process kernel (api, worker and gateway roles): a fake machine speaking
 * `capybara-device/5` signs in to a device of this provider, says hello and changes its owner
 * ceiling; the kernel stores the provider's report and its revision. Operations against a real
 * capybara-device are the end-to-end test's.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
const DEVICE_LOCAL = fileURLToPath(new URL("../src/index.ts", import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startTestKernel(
    testKernelConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [DEVICE_LOCAL],
        roles: ["api", "worker", "gateway"],
        // the device sign-in hands out a connect URL derived from it (the test dials the port)
        http: { port: 0, publicUrl: "https://cap.example.com/" },
      },
    ),
    { resolveFrom: PLUGIN_DIR },
  );
}, 120_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** Signs `name` in and returns the session's Cookie header value (the device confirm needs it). */
async function sessionCookie(name: string): Promise<string> {
  const res = await k.http.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "x-capybara-csrf": "1", "content-type": "application/json" },
    payload: JSON.stringify({ login: name, password: TEST_PASSWORD }),
  });
  expect(res.statusCode, res.body).toBe(200);
  const set = res.headers["set-cookie"];
  return (Array.isArray(set) ? set : [String(set)]).map((c) => c.split(";")[0]).join("; ");
}

const enable = async (req: KernelRequest, orgId: string) => {
  const r = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/device-local`,
    payload: { enabled: true },
  });
  expect(r.statusCode, r.body).toBe(200);
};

/** An unbound program's hello body (it just signed in: no instance generation yet). */
const unboundHello = (ownerCeiling = { ...OWNER_CEILING, outsideSandbox: true }) => ({
  mode: "os",
  roots: ROOTS,
  sessionIsolation: false,
  features: ["networkReport", "projects"],
  home: "/home/me",
  permissionSupport: {
    version: 2,
    boundary: "operation",
    restricted: null,
    network: { openPublic: false, allowlist: false, perOperationHosts: false },
    outsideSandbox: false,
    background: false,
    unavailableReason: "The instance is not bound yet",
  },
  ownerCeiling,
  instanceGeneration: null,
});

type DeviceViewJson = {
  online: boolean | null;
  report: {
    revision: string;
    description: { en: string; zh?: string };
    home: string | null;
  } | null;
};

describe("device-local in a kernel", () => {
  let owner: KernelRequest;
  let cookie: string;
  let orgId: string;

  beforeAll(async () => {
    await createLocalAccount(db, "owner");
    owner = await login(k, "owner");
    cookie = await sessionCookie("owner");
    orgId = await createOrg(owner);
    await enable(owner, orgId);
  });

  const view = async (deviceId: string, req = owner) => {
    const r = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/devices/${deviceId}` });
    return { status: r.statusCode, body: (r.json() as { device: DeviceViewJson }).device };
  };

  it("a device signed in with capybara-device/5 reads online and its report revision reaches devices.report_revision", async () => {
    const signedIn = await signInFakeMachine(k, {
      orgId,
      session: cookie,
      provider: "device-local",
      protocol: DEVICE_DIAL_IN_PROTOCOL,
    });
    const machine = await FakeDialInMachine.connect({
      url: `ws://127.0.0.1:${k.port}/device/connect`,
      credential: signedIn.credential,
      protocol: DEVICE_DIAL_IN_PROTOCOL,
      hello: unboundHello(),
    });
    try {
      const first = await waitFor(async () => {
        const v = await view(signedIn.deviceId);
        return v.body.online === true && v.body.report?.description.en.includes("per approved call")
          ? v.body
          : null;
      });
      expect(first.report?.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(first.report?.home).toBe("/home/me");
      const stored = await db
        .selectFrom("devices")
        .select(sql<string>`report->>'revision'`.as("revision"))
        .where("id", "=", signedIn.deviceId)
        .executeTakeFirstOrThrow();
      expect(stored.revision).toBe(first.report?.revision);

      // the owner turns running outside the sandbox off on the machine
      await machine.send({
        type: "policy",
        ownerCeiling: {
          ...OWNER_CEILING,
          sequence: 2,
          revision: "owner-2",
          outsideSandbox: false,
        },
      });
      const second = await waitFor(async () => {
        const v = await view(signedIn.deviceId);
        return v.body.report?.revision !== first.report?.revision ? v.body : null;
      });
      expect(second.report?.description.en).toContain("never runs outside the sandbox");
      expect(second.report?.description.zh).toContain("从不在沙箱外运行");

      // the plugin's row learned the device's org from the kernel's report call
      const row = await sql<{ org_id: string | null }>`
        SELECT org_id FROM plugin_device_local.connections WHERE device_id = ${signedIn.deviceId}
      `.execute(raw);
      expect(row.rows).toEqual([{ org_id: orgId }]);
    } finally {
      await machine.close();
    }
  });

  it("a hello the provider refuses closes the connection with the provider's code", async () => {
    const signedIn = await signInFakeMachine(k, {
      orgId,
      session: cookie,
      provider: "device-local",
      protocol: DEVICE_DIAL_IN_PROTOCOL,
      name: "refused",
    });
    const refused = await FakeDialInMachine.connect({
      url: `ws://127.0.0.1:${k.port}/device/connect`,
      credential: signedIn.credential,
      protocol: DEVICE_DIAL_IN_PROTOCOL,
      hello: { ...unboundHello(), mode: "vm" },
    }).then(
      () => "accepted",
      (e: unknown) => String(e),
    );
    expect(refused).toContain("local.invalid_hello");
    const rows = await sql`
      SELECT 1 FROM plugin_device_local.connections WHERE device_id = ${signedIn.deviceId}
    `.execute(raw);
    expect(rows.rows).toEqual([]);
  });

  it("a sibling org cannot see the connection row", async () => {
    const signedIn = await signInFakeMachine(k, {
      orgId,
      session: cookie,
      provider: "device-local",
      protocol: DEVICE_DIAL_IN_PROTOCOL,
      name: "sibling",
    });
    const machine = await FakeDialInMachine.connect({
      url: `ws://127.0.0.1:${k.port}/device/connect`,
      credential: signedIn.credential,
      protocol: DEVICE_DIAL_IN_PROTOCOL,
      hello: unboundHello(),
    });
    try {
      await waitFor(async () => ((await view(signedIn.deviceId)).body.report ? true : null));
      // another org of the same person, with device-local on: the device is not its
      const otherOrg = await createOrg(owner, "Sibling");
      await enable(owner, otherOrg);
      const r = await owner({
        method: "GET",
        url: `/api/v1/orgs/${otherOrg}/devices/${signedIn.deviceId}`,
      });
      expect(r.statusCode).toBe(404);
      // the plugin's row names the device's own org only
      const rows = await sql<{ org_id: string }>`
        SELECT org_id FROM plugin_device_local.connections WHERE device_id = ${signedIn.deviceId}
      `.execute(raw);
      expect(rows.rows).toEqual([{ org_id: orgId }]);
    } finally {
      await machine.close();
    }
  });
});

describe("the PG store (the plugin's migrated schema)", () => {
  const HASH = (c: string) => c.repeat(64);
  const RUNTIME = { runtimeHash: HASH("a"), helperHash: HASH("b"), imageFingerprint: HASH("c") };
  const binding = (generation: string, previousGeneration: string | null) => ({
    deviceId: "pg-dev",
    instanceId: "pg-dev",
    generation,
    bindingId: `b-${generation}`,
    previousGeneration,
    status: "awaiting-device" as const,
  });
  const installed = (generation: string, sequence: number) => ({
    runtimeIdentity: { ...RUNTIME, instanceGeneration: generation },
    permissionSupport: SUPPORT,
    ownerCeiling: { ...OWNER_CEILING, sequence, revision: `owner-${sequence}` },
  });

  it("keeps the conditional binding writes, the owner report rule and the org claim", async () => {
    const store = storeOver(pgRows(raw.withSchema("plugin_device_local")));
    expect(await store.binding("pg-dev")).toBeNull();
    // only one of two creates racing from the same previous generation commits
    const raced = await Promise.all([
      store.commitBinding(binding("100", null), null),
      store.commitBinding({ ...binding("100", null), bindingId: "other" }, null),
    ]);
    expect(raced.filter(Boolean)).toHaveLength(1);
    const committed = await store.binding("pg-dev");
    expect(committed?.status).toBe("awaiting-device");
    // an answer for another binding id never installs
    expect(await store.installBinding("pg-dev", "100", "nope", installed("100", 1))).toBe(false);
    expect(
      await store.installBinding(
        "pg-dev",
        "100",
        String(committed?.bindingId),
        installed("100", 1),
      ),
    ).toBe(true);
    expect(await store.binding("pg-dev")).toMatchObject({
      generation: "100",
      status: "installed",
      installed: installed("100", 1),
    });
    expect((await store.binding("pg-dev"))?.unattested).toBeUndefined();

    // a connection row, written and read back through the jsonb columns
    await store.change("pg-dev", (s) => ({
      result: null,
      connection: {
        deviceId: "pg-dev",
        orgId: null,
        machineEpoch: 0,
        mode: "os",
        roots: ROOTS,
        home: "/home/me",
        sessionIsolation: false,
        features: ["projects"],
        permissionSupport: SUPPORT,
        ownerReport: {
          report: { ...OWNER_CEILING, sequence: 2, revision: "owner-2" },
          observedAt: "2026-11-22T00:00:00.000Z",
          via: "hello",
        },
        instanceGeneration: "100",
        runtimeIdentity: { ...RUNTIME, instanceGeneration: "100" },
      },
      ...(s.binding && { binding: { ...s.binding, unattested: true as const } }),
    }));
    const before = await store.state("pg-dev");
    expect(before.binding?.unattested).toBe(true);
    expect(before.connection).toMatchObject({ mode: "os", roots: ROOTS, features: ["projects"] });
    // a stale bind answer (sequence 1 < 2) leaves the owner report, and attests the binding again
    await store.installBinding("pg-dev", "100", String(committed?.bindingId), installed("100", 1));
    const after = await store.state("pg-dev");
    expect(after.connection?.ownerReport?.report.sequence).toBe(2);
    expect(after.binding?.unattested).toBeUndefined();
    expect(revisionOf(after.connection, after.binding)).not.toBe(
      revisionOf(before.connection, before.binding),
    );
    // the org is claimed once; another org reads nothing
    expect((await store.connectionOf("pg-dev", "org-a"))?.orgId).toBe("org-a");
    expect(await store.connectionOf("pg-dev", "org-b")).toBeNull();
    await store.change("pg-dev", (s) => ({
      result: null,
      ...(s.connection && { connection: { ...s.connection, orgId: null } }),
    }));
    expect((await store.state("pg-dev")).connection?.orgId).toBe("org-a");

    await store.forget("pg-dev");
    expect(await store.state("pg-dev")).toEqual({ connection: null, binding: null });
  });
});
