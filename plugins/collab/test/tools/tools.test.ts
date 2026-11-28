import type { InputRequired } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_KEYS } from "../../src/constants.js";
import { assign } from "../../src/domain/assignment.js";
import { createProject } from "../../src/domain/projects.js";
import type { CollabDb } from "../../src/store/db.js";
import { domainDb, ENGINEER, GUEST, OWNER, QA, teamProject } from "../domain/setup.js";
import { confirmed, errorOf, type Harness, text, toolHarness, versionIn } from "./harness.js";

let db: CollabDb;
let close: () => Promise<void>;
let tools: Harness;

const AGENTS = {
  [OWNER.accountId]: [{ id: "agent-pm", name: "PM agent" }],
  [ENGINEER.accountId]: [{ id: "agent-eng", name: "Engineer agent" }],
  // QA lost access to agent-qa (its project default is stale).
  [QA.accountId]: [{ id: "agent-qa2", name: "QA agent 2" }],
  "acct-stranger": [{ id: "agent-x", name: "X" }],
};
const PEOPLE = {
  [OWNER.accountId]: "Wang",
  [ENGINEER.accountId]: "Zhang",
  [QA.accountId]: "Chen",
  "acct-stranger": "Stranger",
};

beforeAll(async () => {
  ({ db, close } = await domainDb());
  tools = toolHarness(db, AGENTS, PEOPLE);
});
afterAll(async () => {
  await close();
});

/** The owner's PM agent in one of the owner's conversations. */
const pm = (orgId: string) => ({ orgId, ownerAccountId: OWNER.accountId, agentId: "agent-pm" });

async function newTask(orgId: string, key: string, title = "Write the report") {
  await teamProject(db, orgId, key);
  const out = text(
    await tools.run("item_create", { project: key, type: "task", title }, pm(orgId)),
  );
  return { key: `${key}-1`, version: versionIn(out), out };
}

describe("collab tools", () => {
  it("registers every declared tool except decision_ask (task C7) with a full description", () => {
    expect([...tools.specs.keys()].sort()).toEqual(
      TOOL_KEYS.filter((k) => k !== "decision_ask").sort(),
    );
    for (const spec of tools.specs.values()) {
      expect(spec.description.split("\n")[0]?.length).toBeGreaterThan(20);
      expect(`plugin__collab__${spec.name}`.length).toBeLessThanOrEqual(64);
    }
  });

  it("item_get on a foreign project returns not found", async () => {
    const org = "org-foreign";
    await createProject(db, org, { accountId: "acct-stranger" }, { key: "SEC", name: "Secret" });
    const stranger = { orgId: org, ownerAccountId: "acct-stranger", agentId: "agent-x" };
    text(
      await tools.run("item_create", { project: "SEC", type: "task", title: "hidden" }, stranger),
    );
    const err = await errorOf(tools.run("item_get", { key: "SEC-1" }, pm(org)));
    expect(err).toMatch(/not found/i);
    expect(err).not.toContain("hidden");
    // The same answer as a key that does not exist at all, and for search and writes.
    expect(await errorOf(tools.run("item_get", { key: "SEC-99" }, pm(org)))).toBe(err);
    expect(await errorOf(tools.run("item_comment", { key: "SEC-1", body: "hi" }, pm(org)))).toMatch(
      /not found/i,
    );
    expect(text(await tools.run("item_search", { query: "hidden" }, pm(org)))).not.toContain(
      "SEC-1",
    );
    // Another org never sees it either.
    expect(
      await errorOf(tools.run("item_get", { key: "SEC-1" }, { ...stranger, orgId: "x" })),
    ).toMatch(/not found/i);
  });

  it("item_assign to another person asks first, then assigns on resume", async () => {
    const org = "org-assign";
    const { key, version } = await newTask(org, "ASG");
    const input = { key, version, responsible: ENGINEER.accountId };
    const asked = (await tools.run("item_assign", input, pm(org))) as InputRequired;
    expect(asked.kind).toBe("input_required");
    expect(JSON.stringify(asked.form)).toContain(
      "Assign ASG-1 to Zhang and their agent Engineer agent?",
    );
    // Nothing changed yet.
    expect(text(await tools.run("item_get", { key }, pm(org)))).toContain("Responsible: none");

    const declined = await tools.run("item_assign", input, {
      ...pm(org),
      resume: confirmed(asked.state, false),
    });
    expect(text(declined)).toMatch(/not assigned/i);
    expect(text(await tools.run("item_get", { key }, pm(org)))).toContain("Responsible: none");

    const asked2 = (await tools.run("item_assign", input, pm(org))) as InputRequired;
    const done = text(
      await tools.run("item_assign", input, { ...pm(org), resume: confirmed(asked2.state, true) }),
    );
    expect(done).toContain("Zhang");
    const got = text(await tools.run("item_get", { key }, pm(org)));
    expect(got).toContain("Responsible: Zhang");
    expect(got).toContain("Engineer agent");
  });

  it("item_assign to self does not ask", async () => {
    const org = "org-self";
    const { key, version } = await newTask(org, "SLF");
    const out = await tools.run(
      "item_assign",
      { key, version, responsible: "me", agent: "agent-pm" },
      pm(org),
    );
    expect("kind" in out).toBe(false);
    expect(text(out)).toContain("PM agent");
    expect(text(await tools.run("item_get", { key }, pm(org)))).toContain("Responsible: Wang");
  });

  it("refuses an agent the responsible person may not use", async () => {
    const org = "org-agent";
    const { key, version } = await newTask(org, "AGT");
    const err = await errorOf(
      tools.run("item_assign", { key, version, responsible: "me", agent: "agent-eng" }, pm(org)),
    );
    expect(err).toMatch(/agent-eng/);
    expect(err).toMatch(/cannot use|may not use/i);
  });

  it("drops a stale default agent with a warning", async () => {
    const org = "org-stale";
    await teamProject(db, org, "STL");
    // QA's default agent in the project (agent-qa) is no longer one QA may use.
    const created = text(
      await tools.run("item_create", { project: "STL", type: "task", title: "check" }, pm(org)),
    );
    const asked = (await tools.run(
      "item_assign",
      { key: "STL-1", version: versionIn(created), responsible: QA.accountId },
      pm(org),
    )) as InputRequired;
    expect(JSON.stringify(asked.form)).toContain("Assign STL-1 to Chen without an agent?");
    const out = text(
      await tools.run(
        "item_assign",
        { key: "STL-1", version: versionIn(created), responsible: QA.accountId },
        { ...pm(org), resume: confirmed(asked.state, true) },
      ),
    );
    expect(out).toMatch(/agent-qa/);
    expect(out).toMatch(/no longer|cannot use/i);
    const got = text(await tools.run("item_get", { key: "STL-1" }, pm(org)));
    expect(got).toContain("Responsible: Chen");
    expect(got).toContain("agent: none");
  });

  it("a default assignment on create drops an agent the member cannot use", async () => {
    const org = "org-default";
    const tools2 = toolHarness(db, { ...AGENTS, [ENGINEER.accountId]: [] }, PEOPLE);
    await teamProject(db, org, "DEF");
    const out = text(
      await tools2.run("item_create", { project: "DEF", type: "bug", title: "crash" }, pm(org)),
    );
    expect(out).toMatch(/agent-eng/);
    const got = text(await tools2.run("item_get", { key: "DEF-1" }, pm(org)));
    expect(got).toContain("Responsible: Zhang");
    expect(got).toContain("agent: none");
  });

  it("write after unassignment fails with no_longer_assigned", async () => {
    const org = "org-gone";
    const { key, version } = await newTask(org, "GON");
    const mine = text(
      await tools.run(
        "item_assign",
        { key, version, responsible: "me", agent: "agent-pm" },
        pm(org),
      ),
    );
    // The PM agent works on it in its item conversation (an automation's subject conversation).
    const item = await db
      .selectFrom("items")
      .selectAll()
      .where("org_id", "=", org)
      .executeTakeFirstOrThrow();
    tools.work.set(item.id, ["conv-work"]);
    const inWork = { ...pm(org), conversationId: "conv-work", rootConversationId: "conv-work" };
    text(await tools.run("item_comment", { key, body: "on it" }, inWork));
    // The owner, a person, hands it to the engineer while the agent's run continues.
    await assign(db, org, OWNER, item.id, versionIn(mine), {
      responsibleAccountId: ENGINEER.accountId,
      executingAgentId: "agent-eng",
    });
    const err = await errorOf(tools.run("item_comment", { key, body: "done" }, inWork));
    expect(err).toMatch(/no longer assigned/i);
    expect(
      await errorOf(
        tools.run("item_update", { key, version: item.version + 2, patch: { title: "x" } }, inWork),
      ),
    ).toMatch(/no longer assigned/i);
    // A sub-agent of that run counts through its root conversation.
    const sub = { ...inWork, conversationId: "conv-sub" };
    expect(await errorOf(tools.run("item_comment", { key, body: "sub" }, sub))).toMatch(
      /no longer assigned/i,
    );
    // Reading still works.
    expect(text(await tools.run("item_get", { key }, inWork))).toContain("Responsible: Zhang");
    // The same pair in another conversation writes as an ordinary member.
    const other = { ...pm(org), conversationId: "conv-other", rootConversationId: "conv-other" };
    expect(text(await tools.run("item_comment", { key, body: "fyi" }, other))).toContain(
      "Commented",
    );
  });

  it("refuses a run started by someone other than the conversation's owner", async () => {
    const org = "org-foreign-run";
    await teamProject(db, org, "FRN");
    const call = { ...pm(org), accountId: ENGINEER.accountId };
    for (const [name, input] of [
      ["project_list", {}],
      ["item_create", { project: "FRN", type: "task", title: "x" }],
    ] as const) {
      expect(await errorOf(tools.run(name, input, call))).toMatch(/conversation's owner/);
    }
    const count = await db
      .selectFrom("items")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", org)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });

  it("item_create with another responsible asks; decline creates nothing, confirm creates", async () => {
    const org = "org-create-ask";
    await teamProject(db, org, "CRA");
    const input = { project: "CRA", type: "task", title: "Fix login", responsible: "Zhang" };
    const asked = (await tools.run("item_create", input, pm(org))) as InputRequired;
    expect(asked.kind).toBe("input_required");
    expect(JSON.stringify(asked.form)).toContain(
      'Create task \\"Fix login\\" in CRA assigned to Zhang and their agent Engineer agent?',
    );
    const declined = await tools.run("item_create", input, {
      ...pm(org),
      resume: confirmed(asked.state, false),
    });
    expect(text(declined)).toMatch(/not created/i);
    expect(await errorOf(tools.run("item_get", { key: "CRA-1" }, pm(org)))).toMatch(/not found/i);
    const asked2 = (await tools.run("item_create", input, pm(org))) as InputRequired;
    const created = text(
      await tools.run("item_create", input, { ...pm(org), resume: confirmed(asked2.state, true) }),
    );
    expect(created).toContain("Created CRA-1");
    const got = text(await tools.run("item_get", { key: "CRA-1" }, pm(org)));
    expect(got).toContain("Responsible: Zhang");
    expect(got).toContain("Engineer agent");
  });

  it("a guest's write through a tool is refused", async () => {
    const org = "org-guest-tool";
    await teamProject(db, org, "GTL");
    text(await tools.run("item_create", { project: "GTL", type: "task", title: "t" }, pm(org)));
    const guest = { orgId: org, ownerAccountId: GUEST.accountId, agentId: "agent-g" };
    expect(text(await tools.run("item_get", { key: "GTL-1" }, guest))).toContain("GTL-1");
    expect(await errorOf(tools.run("item_comment", { key: "GTL-1", body: "hi" }, guest))).toMatch(
      /Guests can read/,
    );
    expect(
      await errorOf(tools.run("item_create", { project: "GTL", type: "task", title: "g" }, guest)),
    ).toMatch(/Guests can read/);
  });

  it("item_transition into a gate reports waiting", async () => {
    const org = "org-gate";
    await teamProject(db, org, "GAT");
    let out = text(
      await tools.run(
        "item_create",
        { project: "GAT", type: "requirement", title: "Export as PDF" },
        pm(org),
      ),
    );
    for (const to of ["drafting", "review"]) {
      out = text(
        await tools.run("item_transition", { key: "GAT-1", version: versionIn(out), to }, pm(org)),
      );
      expect(out).toContain(`moved to ${to}`);
    }
    const gated = text(
      await tools.run(
        "item_transition",
        { key: "GAT-1", version: versionIn(out), to: "ready" },
        pm(org),
      ),
    );
    expect(gated).toMatch(/gate requested/i);
    expect(gated).toContain("waiting on Wang");
    expect(text(await tools.run("item_get", { key: "GAT-1" }, pm(org)))).toContain("review");
    const decisions = text(await tools.run("decision_list", { key: "GAT-1" }, pm(org)));
    expect(decisions).toContain("Wang");
    expect(decisions).toContain("ready");
  });

  it("creates, searches, updates, links, comments and attaches", async () => {
    const org = "org-flow";
    await teamProject(db, org, "FLW");
    const a = text(
      await tools.run(
        "item_create",
        { project: "FLW", type: "task", title: "Alpha report", labels: ["pdf"] },
        pm(org),
      ),
    );
    text(
      await tools.run(
        "item_create",
        { project: "FLW", type: "task", title: "Beta chart", parent: "FLW-1" },
        pm(org),
      ),
    );
    const found = text(await tools.run("item_search", { project: "FLW", query: "alpha" }, pm(org)));
    expect(found).toContain("FLW-1");
    expect(found).not.toContain("FLW-2");
    // Tool writes emit their events at once, caused by the tool call (its kernel handle).
    expect(tools.emitted).toContainEqual({ type: "item.created", cause: { handle: "handle" } });
    const updated = text(
      await tools.run(
        "item_update",
        { key: "FLW-1", version: versionIn(a), patch: { priority: 1, description: "Do it" } },
        pm(org),
      ),
    );
    expect(versionIn(updated)).toBe(versionIn(a) + 1);
    expect(
      await errorOf(
        tools.run(
          "item_update",
          { key: "FLW-1", version: versionIn(a), patch: { priority: 2 } },
          pm(org),
        ),
      ),
    ).toMatch(/item_get/);
    text(await tools.run("item_link", { key: "FLW-2", to: "FLW-1", kind: "blocks" }, pm(org)));
    text(await tools.run("item_comment", { key: "FLW-1", body: "Started." }, pm(org)));
    text(
      await tools.run(
        "artifact_attach",
        { key: "FLW-1", kind: "prd", name: "PRD", url: "https://docs.example.com/prd" },
        pm(org),
      ),
    );
    text(
      await tools.run(
        "artifact_attach",
        { key: "FLW-1", kind: "pr", name: "PR 12", url: "https://git.example.com/pr/12" },
        pm(org),
      ),
    );
    const got = text(await tools.run("item_get", { key: "FLW-1" }, pm(org)));
    for (const s of [
      "Do it",
      "FLW-2",
      "blocked by",
      "PRD",
      "https://git.example.com/pr/12",
      "commented",
    ]) {
      expect(got).toContain(s);
    }
    const projects = text(await tools.run("project_list", {}, pm(org)));
    expect(projects).toContain("FLW");
    expect(projects).toContain("Zhang");
  });
});
