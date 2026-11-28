import type {
  ExtensionContext,
  JsonValue,
  UiActionResult,
  UiOrgActionArgs,
  UiRole,
} from "@capybara-hq/plugin-sdk";
import type { QueryName } from "../../src/page/contract.js";
import { runQuery } from "../../src/page/queries.js";
import type { CollabDb } from "../../src/store/db.js";
import { dispatchAction } from "../../src/ui/actions.js";
import { noticeCtx } from "../notices/fake.js";

/** Display names of the test accounts; anyone else is not an org member. */
const NAMES: Record<string, string> = {
  "acct-owner": "Wang",
  "acct-eng": "Zhang",
  "acct-qa": "Chen",
  "acct-guest": "Guest",
  "acct-stranger": "Stranger",
  "acct-new": "Newcomer",
};

/** The notices fake plus org people, and helpers that call the page as a person. */
export function pageCtx(db: CollabDb, agents: Record<string, { id: string; name: string }[]>) {
  const base = noticeCtx(db, agents);
  /** Accounts whose usable agents were read, in order. */
  const agentReads: string[] = [];
  const ctx = {
    ...base.ctx,
    agents: {
      usableBy: async (a: { orgId: string; accountId: string }) => {
        agentReads.push(a.accountId);
        return base.ctx.agents.usableBy(a);
      },
    },
    people: {
      get: async ({ accountIds }: { orgId: string; accountIds: string[] }) =>
        accountIds
          .filter((id) => NAMES[id])
          .map((id) => ({ id, name: NAMES[id] as string, avatar: null, active: true })),
      search: async ({ query }: { orgId: string; query: string }) =>
        Object.entries(NAMES)
          .filter(([, n]) => n.toLowerCase().includes(query.toLowerCase()))
          .map(([id, name]) => ({ id, name, avatar: null })),
    },
  } as unknown as ExtensionContext;
  return {
    ...base,
    ctx,
    agentReads,
    /** Runs a query of a component as `accountId`. */
    query<T = unknown>(
      orgId: string,
      accountId: string,
      query: QueryName,
      params: JsonValue = {},
      extra: { component?: string; conversationId?: string; agentId?: string; role?: UiRole } = {},
    ): Promise<T> {
      return runQuery({ ctx, db }, extra.component ?? "projects", {
        orgId,
        accountId,
        role: extra.role ?? "member",
        query,
        params,
        ...(extra.conversationId ? { conversationId: extra.conversationId } : {}),
        ...(extra.agentId ? { agentId: extra.agentId } : {}),
      }) as Promise<T>;
    },
    /** Runs a page action as `accountId`. */
    act(
      orgId: string,
      accountId: string,
      actionId: string,
      payload: unknown,
      role: UiRole = "member",
    ): Promise<ToastResult> {
      return dispatchAction({ ctx, db }, {
        scope: "org",
        orgId,
        accountId,
        role,
        actionId,
        payload,
      } as UiOrgActionArgs) as Promise<ToastResult>;
    },
  };
}

/** Page actions never answer with a view. */
type ToastResult = Exclude<UiActionResult, { view: unknown }>;
