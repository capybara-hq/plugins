import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDecisionJob } from "../../src/decisions-queue.js";
import { createItem, transition } from "../../src/domain/items.js";
import "../../src/page/actions.js";
import type { CollabDb } from "../../src/store/db.js";
import { domainDb, ENGINEER, NO_DECISION_JOBS, OWNER, QA, teamProject } from "../domain/setup.js";
import { pageCtx } from "./fake.js";

let db: CollabDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await domainDb());
});
afterAll(async () => {
  await close();
});

const NEW = "acct-new";
const agents = () => ({
  [OWNER.accountId]: [{ id: "agent-pm", name: "PM agent" }],
  [ENGINEER.accountId]: [{ id: "agent-eng", name: "Engineer agent" }],
  [QA.accountId]: [{ id: "agent-qa", name: "QA agent" }],
  [NEW]: [{ id: "agent-new", name: "New agent" }],
});

/** A requirement in review whose "ready" gate any engineering member confirms. */
async function functionGate(org: string, key: string, fake: ReturnType<typeof pageCtx>) {
  const project = await teamProject(db, org, key);
  let item = await createItem(db, org, OWNER, {
    projectId: project.id,
    type: "requirement",
    title: "Export",
  });
  for (const to of ["drafting", "review"]) {
    const out = await transition(db, org, ENGINEER, item.id, item.version, to, {
      decisions: NO_DECISION_JOBS,
    });
    if (!("item" in out)) throw new Error("unexpected gate");
    item = out.item;
  }
  await fake.act(org, OWNER.accountId, "settings.save", {
    projectId: project.id,
    statuses: [
      {
        type: "requirement",
        key: "ready",
        gate: { confirmer: "function", functionLabel: "engineering" },
      },
    ],
  });
  return { project, item };
}

async function decisionOf(itemId: string) {
  return db
    .selectFrom("decisions")
    .selectAll()
    .where("item_id", "=", itemId)
    .executeTakeFirstOrThrow();
}

const noticesTo = (fake: ReturnType<typeof pageCtx>, account: string) =>
  fake.posts.filter((p) => p.kind === "collab.decision" && p.accountId === account);

describe("gate recipients follow the confirmer set", () => {
  it("label added: the newcomer is asked; removed: their item is resolved; first answer resolves all", async () => {
    const org = "org-addr-set";
    const fake = pageCtx(db, agents());
    const { project, item } = await functionGate(org, "ADS", fake);
    await fake.act(org, QA.accountId, "item.move", {
      itemId: item.id,
      version: item.version,
      to: "ready",
    });
    expect(noticesTo(fake, ENGINEER.accountId)).toHaveLength(1);
    expect((await decisionOf(item.id)).addressees).toEqual([ENGINEER.accountId]);

    // A second engineer: asked too; the first engineer is not asked again.
    await fake.act(org, OWNER.accountId, "member.add", {
      projectId: project.id,
      accountId: NEW,
      role: "member",
      functionLabel: "engineering",
    });
    let gate = await decisionOf(item.id);
    expect(gate.addressees).toEqual([ENGINEER.accountId, NEW]);
    expect(noticesTo(fake, NEW)).toHaveLength(1);
    expect(noticesTo(fake, ENGINEER.accountId)).toHaveLength(1);
    // Each recipient's item carries the step's plain key (the SDK dedupes per account).
    expect(noticesTo(fake, NEW)[0]?.dedupeKey).toBe(`${gate.id}-${gate.address_gen}`);
    const engItem = gate.inbox_by_account[ENGINEER.accountId]?.notify;
    expect(engItem).toBeTruthy();

    // The first engineer loses the label: their item is resolved, the newcomer keeps theirs.
    await fake.act(org, OWNER.accountId, "member.function", {
      projectId: project.id,
      accountId: ENGINEER.accountId,
      functionLabel: null,
    });
    gate = await decisionOf(item.id);
    expect(gate.addressees).toEqual([NEW]);
    expect(fake.resolved).toContain(engItem);
    expect(gate.inbox_item_ids).not.toContain(engItem);
    const newItem = gate.inbox_by_account[NEW]?.notify;
    expect(fake.resolved).not.toContain(newItem);

    // Label back: asked again; then the first answer resolves every recipient's item.
    await fake.act(org, OWNER.accountId, "member.function", {
      projectId: project.id,
      accountId: ENGINEER.accountId,
      functionLabel: "engineering",
    });
    gate = await decisionOf(item.id);
    expect(gate.addressees).toEqual([ENGINEER.accountId, NEW]);
    const ids = Object.values(gate.inbox_by_account).map((x) => x.notify);
    expect(ids).toHaveLength(2);
    expect(
      await fake.act(org, NEW, "gate.confirm", { decisionId: gate.id, approve: true }),
    ).not.toHaveProperty("toast");
    for (const id of ids) expect(fake.resolved).toContain(id);
  });

  it("a transient inbox failure mid-fanout keeps the posted items; the retry asks only the rest", async () => {
    const org = "org-addr-retry";
    const fake = pageCtx(db, agents());
    const { project, item } = await functionGate(org, "ADR", fake);
    await fake.act(org, OWNER.accountId, "member.add", {
      projectId: project.id,
      accountId: NEW,
      role: "member",
      functionLabel: "engineering",
    });
    fake.failures.postsTo.add(NEW);
    await fake.act(org, QA.accountId, "item.move", {
      itemId: item.id,
      version: item.version,
      to: "ready",
    });
    let gate = await decisionOf(item.id);
    expect(gate.notified_at).toBeNull();
    expect(Object.keys(gate.inbox_by_account)).toEqual([ENGINEER.accountId]);
    expect(gate.inbox_item_ids).toHaveLength(1);
    await runDecisionJob(fake.ctx, { orgId: org, decisionId: gate.id, step: "notify", gen: 0 });
    gate = await decisionOf(item.id);
    expect(gate.notified_at).not.toBeNull();
    expect(gate.inbox_item_ids).toHaveLength(2);
    expect(noticesTo(fake, ENGINEER.accountId)).toHaveLength(1);
    expect(noticesTo(fake, NEW)).toHaveLength(1);
  });

  it("escalation names every confirmer and is skipped when the owner confirms", async () => {
    const org = "org-addr-escalate";
    const fake = pageCtx(db, agents());
    const { project, item } = await functionGate(org, "ADE", fake);
    await fake.act(org, OWNER.accountId, "member.add", {
      projectId: project.id,
      accountId: NEW,
      role: "member",
      functionLabel: "engineering",
    });
    await fake.act(org, QA.accountId, "item.move", {
      itemId: item.id,
      version: item.version,
      to: "ready",
    });
    const gate = await decisionOf(item.id);
    await runDecisionJob(fake.ctx, { orgId: org, decisionId: gate.id, step: "escalate" });
    const escalated = fake.posts.filter((p) => p.kind === "collab.decision.escalated");
    expect(escalated).toHaveLength(1);
    expect(escalated[0]?.accountId).toBe(OWNER.accountId);
    expect(escalated[0]?.body).toContain("Zhang, Newcomer have not answered");

    // The owner as a confirmer: nobody to escalate to.
    await fake.act(org, OWNER.accountId, "member.function", {
      projectId: project.id,
      accountId: OWNER.accountId,
      functionLabel: "engineering",
    });
    await db
      .updateTable("decisions")
      .set({ escalated_at: null })
      .where("id", "=", gate.id)
      .execute();
    const before = fake.posts.length;
    await runDecisionJob(fake.ctx, { orgId: org, decisionId: gate.id, step: "escalate" });
    expect(fake.posts.filter((p) => p.kind === "collab.decision.escalated")).toHaveLength(1);
    expect(fake.posts.length).toBe(before);
  });
});

describe("settings and member refusals", () => {
  it("refusals refetch the project queries; unchanged rules are not re-checked; kernel failures refuse", async () => {
    const org = "org-addr-settings";
    const map = agents();
    const fake = pageCtx(db, map);
    const project = await teamProject(db, org, "ADX");
    const notOwner = await fake.act(org, ENGINEER.accountId, "member.add", {
      projectId: project.id,
      accountId: NEW,
      role: "member",
    });
    expect(notOwner.invalidate).toContain("project.settings");
    const rule = {
      type: "task",
      key: "testing",
      defaultAssignment: { accountId: QA.accountId, agentId: "agent-qa" },
    };
    const save = (statuses: object[], name?: string) =>
      fake.act(org, OWNER.accountId, "settings.save", {
        projectId: project.id,
        ...(name ? { name } : {}),
        statuses,
      });
    expect(await save([rule])).not.toHaveProperty("toast");
    // QA can no longer use the agent: the stored rule is not re-checked on an unrelated save…
    map[QA.accountId] = [];
    fake.agentReads.length = 0;
    expect(await save([rule], "Renamed")).not.toHaveProperty("toast");
    expect(fake.agentReads).toEqual([]);
    // …but a changed rule is, and its refusal refetches the settings.
    const changed = await save([
      {
        type: "task",
        key: "testing",
        defaultAssignment: { accountId: QA.accountId, agentId: "agent-qa", memberAgent: true },
      },
    ]);
    expect(changed.toast?.en).toContain("cannot use this agent");
    expect(changed.invalidate).toContain("project.settings");
    fake.failures.people = true;
    const down = await save([
      { type: "requirement", key: "ready", gate: { confirmer: "member", accountId: QA.accountId } },
    ]);
    expect(down.toast?.en).toContain("could not be checked");
  });
});
