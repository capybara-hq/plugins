import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import type { Actor } from "../store/types.js";
import type { ActorRef, AgentRef, PersonRef } from "./contract.js";

/** `ctx.people.get` takes at most this many ids per call. */
const PEOPLE_BATCH = 200;

/**
 * Display names and avatars for one query: people through `ctx.people.get`, agents through the
 * agents their person may use (`ctx.agents.usableBy`; the kernel has no lookup by agent id).
 * Lookups are memoized for this request only; a failed read falls back to the ids.
 */
export class Directory {
  private readonly people = new Map<string, PersonRef>();
  private readonly agentsOf = new Map<string, Promise<Map<string, AgentRef>>>();

  constructor(
    private readonly ctx: Pick<ExtensionContext, "people" | "agents" | "log">,
    private readonly orgId: string,
  ) {}

  /** Loads the given people (call once with every id the result names, then use {@link person}). */
  async load(ids: Iterable<string | null | undefined>): Promise<void> {
    const missing = [...new Set([...ids].filter((id): id is string => Boolean(id)))].filter(
      (id) => !this.people.has(id),
    );
    for (let i = 0; i < missing.length; i += PEOPLE_BATCH) {
      const batch = missing.slice(i, i + PEOPLE_BATCH);
      try {
        for (const p of await this.ctx.people.get({ orgId: this.orgId, accountIds: batch })) {
          this.people.set(p.id, { id: p.id, name: p.name, avatar: p.avatar });
        }
      } catch (err) {
        this.ctx.log.warn("collab could not read people for a page", { orgId: this.orgId, err });
      }
      for (const id of batch) {
        if (!this.people.has(id)) this.people.set(id, { id, name: id, avatar: null });
      }
    }
  }

  /** A person loaded by {@link load} (or a fallback with the id as the name). */
  person(id: string): PersonRef {
    return this.people.get(id) ?? { id, name: id, avatar: null };
  }

  personOrNull(id: string | null | undefined): PersonRef | null {
    return id ? this.person(id) : null;
  }

  /** The agents `accountId` may use, by id. */
  usable(accountId: string): Promise<Map<string, AgentRef>> {
    let found = this.agentsOf.get(accountId);
    if (!found) {
      found = this.ctx.agents
        .usableBy({ orgId: this.orgId, accountId })
        .then(
          (list) => new Map(list.map((a) => [a.id, { id: a.id, name: a.name, avatar: a.avatar }])),
        )
        .catch((err: unknown) => {
          this.ctx.log.warn("collab could not read usable agents for a page", {
            orgId: this.orgId,
            err,
          });
          return new Map<string, AgentRef>();
        });
      this.agentsOf.set(accountId, found);
    }
    return found;
  }

  /** Reads the usable agents of every distinct person at once (before naming many agents). */
  async prefetchAgents(accountIds: Iterable<string | null | undefined>): Promise<void> {
    const ids = [...new Set([...accountIds].filter((id): id is string => Boolean(id)))];
    await Promise.all(ids.map((id) => this.usable(id)));
  }

  /** The agent working for `accountId` (named through that person's usable agents). */
  async agent(accountId: string | null, agentId: string | null): Promise<AgentRef | null> {
    if (!agentId) return null;
    const known = accountId ? (await this.usable(accountId)).get(agentId) : undefined;
    return known ?? { id: agentId, name: agentId, avatar: null };
  }

  /** An actor as stored in activity, comments and decisions (load its person first). */
  async actor(actor: Actor): Promise<ActorRef> {
    return {
      person: this.person(actor.accountId),
      agent: "agentId" in actor ? await this.agent(actor.accountId, actor.agentId) : null,
    };
  }
}
