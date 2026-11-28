import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import type { DecisionHooks } from "../../src/domain/decision-state.js";
import { addMember, createProject } from "../../src/domain/projects.js";
import { type CollabDb, collabDb } from "../../src/store/db.js";
import type { Project } from "../../src/store/types.js";
import { migrate, pluginDb } from "../helpers.js";

/** A migrated `plugin_collab` database for one test file. */
export async function domainDb(): Promise<{ db: CollabDb; close: () => Promise<void> }> {
  const pgc: TestContainer = await startTestPostgres();
  await migrate(pgc.url);
  const { db, destroy } = pluginDb(pgc.url);
  return {
    db: collabDb(db),
    close: async () => {
      await destroy();
      await pgc.stop();
    },
  };
}

/** Decision hooks that owe nothing: for domain tests that do not look at inbox items. */
export const NO_DECISION_JOBS: DecisionHooks = {
  created: async () => {},
  readdressed: async () => {},
  closed: async () => {},
};

export const OWNER = { accountId: "acct-owner" };
export const ENGINEER = { accountId: "acct-eng" };
export const QA = { accountId: "acct-qa" };
export const GUEST = { accountId: "acct-guest" };
/** The owner's agent acting in one of the owner's conversations. */
export const OWNER_AGENT = {
  accountId: "acct-owner",
  agentId: "agent-pm",
  conversationId: "conv-1",
};

/** A project owned by OWNER with an engineer (engineering, agent-eng), a QA (qa, agent-qa) and a guest. */
export async function teamProject(db: CollabDb, orgId: string, key: string): Promise<Project> {
  const project = await createProject(db, orgId, OWNER, { key, name: `Project ${key}` });
  await addMember(db, orgId, OWNER, project.id, ENGINEER.accountId, {
    role: "member",
    functionLabel: "engineering",
    defaultAgentId: "agent-eng",
  });
  await addMember(db, orgId, OWNER, project.id, QA.accountId, {
    role: "member",
    functionLabel: "qa",
    defaultAgentId: "agent-qa",
  });
  await addMember(db, orgId, OWNER, project.id, GUEST.accountId, { role: "guest" });
  return project;
}

/** The outbox rows of an item, oldest first (rows of one transaction share a time: then by type). */
export async function outboxOf(db: CollabDb, orgId: string, itemId: string) {
  const rows = await db
    .selectFrom("event_outbox")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("created_at")
    .orderBy("type")
    .execute();
  return rows.filter((r) => (r.subject as { id: string }).id === itemId);
}
