import type {
  ExtensionContext,
  InboxPost,
  SubjectConversation,
  UiActionResult,
  UiOrgActionArgs,
} from "@capybara-hq/plugin-sdk";
import type { CollabDb } from "../../src/store/db.js";
import { dispatchAction } from "../../src/ui/actions.js";

/** A stand-in ctx for notices and run state: real database, recording kernel calls. */
export function noticeCtx(db: CollabDb, agents: Record<string, { id: string; name: string }[]>) {
  const posts: InboxPost[] = [];
  const openKeys = new Set<string>();
  const invalidations: { orgId?: string; contribution: string }[] = [];
  /** The subject conversations `bySubject` returns, by item id. */
  const conversations = new Map<string, SubjectConversation[]>();
  const ctx = {
    db,
    log: { info() {}, warn() {}, error() {} },
    inbox: {
      // The kernel's dedupe: an open item with the same key is returned, not posted again.
      async post(p: InboxPost) {
        const key = `${p.orgId}/${p.accountId}/${p.dedupeKey}`;
        if (!p.dedupeKey || !openKeys.has(key)) posts.push(p);
        if (p.dedupeKey) openKeys.add(key);
        return { itemId: `inbox-${posts.length}` };
      },
      async resolve() {},
    },
    agents: {
      usableBy: async ({ accountId }: { orgId: string; accountId: string }) =>
        (agents[accountId] ?? []).map((a) => ({ ...a, avatar: null })),
    },
    people: { get: async () => [], search: async () => [] },
    conversations: {
      bySubject: async ({ subject }: { orgId: string; subject: { kind: string; id: string } }) =>
        conversations.get(subject.id) ?? [],
    },
    ui: {
      async invalidate(t: { orgId?: string; contribution: string }) {
        invalidations.push(t);
      },
    },
    triggers: {
      emit: async () => ({ eventId: "e", duplicate: false }),
      causeOf: async () => "handle",
    },
    queue: { define() {}, add: async () => {} },
  } as unknown as ExtensionContext;
  return {
    ctx,
    posts,
    invalidations,
    conversations,
    /** Clicks an inbox action's UI action as `accountId`. */
    click(orgId: string, accountId: string, post: InboxPost, id: string): Promise<UiActionResult> {
      const action = post.actions?.find((a) => a.id === id);
      if (!action) throw new Error(`no action ${id}`);
      return dispatchAction({ ctx, db }, {
        scope: "org",
        orgId,
        accountId,
        role: "member",
        actionId: action.uiAction.actionId,
        payload: action.uiAction.payload,
      } as UiOrgActionArgs);
    },
  };
}
