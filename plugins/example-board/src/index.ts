import { defineExtension, type ExtensionContext, type RouteCaller } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { BOARD_HTML, BOARD_JS } from "./page.js";

/** The caller of a data route with an org embed token (the board never runs on a platform page). */
type OrgCaller = Extract<RouteCaller, { access: "embed"; scope: "org" }>;

type Db = ExtensionContext["db"];

// capybara:allow-module-state 只读常量：卡片状态的固定取值
const STATUSES = ["todo", "doing", "done"] as const;
type Status = (typeof STATUSES)[number];

/** 卡片（接口返回的形状）。 */
export interface Card {
  id: string;
  title: string;
  status: Status;
  conversationId: string | null;
}

/** bus 上的变更通知（主题 `cards.<orgId>`，插件自己的命名空间）。 */
interface CardChange {
  cardId: string;
  status: Status;
  conversationId: string | null;
}

const CreateBody = z.object({ title: z.string().trim().min(1).max(200) });
const MoveBody = z.object({ status: z.enum(STATUSES) });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CARDS = 200;
/** SSE 心跳间隔：中间层（Web 代理、负载均衡）不会把空闲连接掐断。 */
const HEARTBEAT_MS = 15_000;

const cardsTopic = (orgId: string) => `cards.${orgId}`;

const json = (status: number, body: unknown) => Response.json(body, { status });
const error = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });
const forbidden = () => error(403, "forbidden", "The board needs an org embed token");

/** The kernel verified the embed token; the board only accepts an org-scope one. */
const orgCaller = (caller: RouteCaller): OrgCaller | null =>
  caller.access === "embed" && caller.scope === "org" ? caller : null;

const toCard = (r: Record<string, unknown>): Card => ({
  id: String(r.id),
  title: String(r.title),
  status: r.status as Status,
  conversationId: (r.conversation_id as string | null) ?? null,
});

const parseChange = (m: unknown): CardChange | undefined => {
  if (typeof m !== "object" || m === null) return undefined;
  const x = m as Record<string, unknown>;
  if (typeof x.cardId !== "string" || !STATUSES.includes(x.status as Status)) return undefined;
  const conversationId = typeof x.conversationId === "string" ? x.conversationId : null;
  return { cardId: x.cardId, status: x.status as Status, conversationId };
};

/** 读请求体并按 schema 校验；不是 JSON 或不合规返回 undefined。 */
async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const r = schema.safeParse(await req.json());
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a token sees: a conversation embed sees only that conversation's cards; the org page sees
 * only cards outside any conversation (a conversation's cards are reachable only with a board-conv
 * token naming that conversation; an org page token neither sees nor changes them).
 */
// biome-ignore lint/suspicious/noExplicitAny: 插件自带表结构，Kysely 未声明类型
function scoped(q: any, who: OrgCaller): any {
  const byOrg = q.where("org_id", "=", who.orgId);
  return who.conversationId === undefined
    ? byOrg.where("conversation_id", "is", null)
    : byOrg.where("conversation_id", "=", who.conversationId);
}

async function listCards(db: Db, who: OrgCaller): Promise<Card[]> {
  const rows = await scoped(
    db.selectFrom("cards").select(["id", "title", "status", "conversation_id"]),
    who,
  )
    .orderBy("created_at")
    .orderBy("id")
    .limit(MAX_CARDS)
    .execute();
  return (rows as Record<string, unknown>[]).map(toCard);
}

/** 在一个可中止的等待里睡 ms（只用于本次请求内的心跳，随请求结束而结束）。 */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const s = AbortSignal.any([AbortSignal.timeout(ms), signal]);
    if (s.aborted) resolve();
    else s.addEventListener("abort", () => resolve(), { once: true });
  });

/**
 * The reference plugin for tier-two UI (embedded apps): a minimal workflow progress board.
 * - The org page `board` (top bar "Extensions") and the conversation panel `board-conv` are both
 *   extension pages in an iframe;
 * - the page and script are `public` GETs (no data); every data route is `access: "embed"`: the
 *   kernel verifies the token (Bearer or `?token=`) before the handler, and identity (org, account,
 *   conversation) comes only from `caller`;
 * - `/ui/events` (SSE) subscribes to `ctx.bus` per request and unsubscribes and ends when the client
 *   disconnects or at `caller.exp` (the page reconnects with the renewed token);
 * - no timers and no module-level mutable state: refresh across replicas goes through the bus.
 */
export default defineExtension({
  name: "example-board",
  version: "0.1.0-rc.2",
  sdk: "^0.1.0-rc.0",
  provides: [],
  migrations: "../migrations",
  ui: [
    {
      id: "board",
      title: { zh: "看板", en: "Board" },
      place: "page",
      kind: "embed",
      path: "/ui/board",
      icon: "layout-grid",
    },
    {
      id: "board-conv",
      title: { zh: "看板", en: "Board" },
      place: "conversation",
      kind: "embed",
      path: "/ui/board-conv",
      // the old place: still a right panel (UI refresh B), with its title-bar icon
      icon: "layout-grid",
    },
  ],
  permissions: {
    http: [
      { method: "GET", path: "/ui/board", access: "public" },
      { method: "GET", path: "/ui/board-conv", access: "public" },
      { method: "GET", path: "/ui/board.js", access: "public" },
      { method: "GET", path: "/ui/cards", access: "embed" },
      { method: "POST", path: "/ui/cards", access: "embed" },
      { method: "POST", path: "/ui/cards/:id", access: "embed" },
      { method: "GET", path: "/ui/events", access: "embed" },
    ],
    ui: { embeds: ["board", "board-conv"] },
  },
  setup(ctx) {
    const publish = (orgId: string, change: CardChange) =>
      ctx.bus.publish(cardsTopic(orgId), change);

    // ---- Static page and script: no data, public ----
    const html = async () =>
      new Response(BOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    ctx.http.route("GET", "/ui/board", html);
    ctx.http.route("GET", "/ui/board-conv", html);
    ctx.http.route(
      "GET",
      "/ui/board.js",
      async () =>
        new Response(BOARD_JS, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-cache",
          },
        }),
    );

    // ---- Data: the kernel has verified the embed token; a platform-scope token (no org) is 403 ----
    ctx.http.route("GET", "/ui/cards", async (_req, caller) => {
      const who = orgCaller(caller);
      if (!who) return forbidden();
      return json(200, { cards: await listCards(ctx.db, who) });
    });

    ctx.http.route("POST", "/ui/cards", async (req, caller) => {
      const who = orgCaller(caller);
      if (!who) return forbidden();
      const input = await body(req, CreateBody);
      if (!input) return error(400, "validation_failed", "title must be 1-200 characters");
      const row = await ctx.db
        .insertInto("cards")
        .values({
          org_id: who.orgId,
          conversation_id: who.conversationId ?? null,
          title: input.title,
        })
        .returning(["id", "title", "status", "conversation_id"])
        .executeTakeFirstOrThrow();
      const card = toCard(row);
      await publish(who.orgId, {
        cardId: card.id,
        status: card.status,
        conversationId: card.conversationId,
      });
      return json(201, { card });
    });

    ctx.http.route("POST", "/ui/cards/:id", async (req, caller) => {
      const who = orgCaller(caller);
      if (!who) return forbidden();
      const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
      if (!UUID_RE.test(id)) return error(404, "not_found", "Card not found");
      const input = await body(req, MoveBody);
      if (!input) return error(400, "validation_failed", "status must be todo, doing or done");
      const row = await scoped(
        ctx.db
          .updateTable("cards")
          .set({ status: input.status, updated_at: new Date() })
          .where("id", "=", id),
        who,
      )
        .returning(["id", "title", "status", "conversation_id"])
        .executeTakeFirst();
      if (!row) return error(404, "not_found", "Card not found");
      const card = toCard(row);
      await publish(who.orgId, {
        cardId: card.id,
        status: card.status,
        conversationId: card.conversationId,
      });
      return json(200, { card });
    });

    // ---- 实时刷新：SSE，按请求订阅 bus ----
    ctx.http.route("GET", "/ui/events", async (req, caller) => {
      const who = orgCaller(caller);
      if (!who) return forbidden();
      // End when the client disconnects or the token expires (caller.exp): the page reconnects with
      // the renewed token, so access expires with the token
      const done = AbortSignal.any([
        req.signal,
        AbortSignal.timeout(Math.max(1, who.exp * 1000 - Date.now())),
      ]);
      const enc = new TextEncoder();
      let closed = false;
      let unsubscribe: (() => Promise<void>) | undefined;
      const stop = () => {
        if (closed) return;
        closed = true;
        const u = unsubscribe;
        unsubscribe = undefined;
        if (u) void u().catch(() => {});
      };
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (s: string) => {
            if (!closed) controller.enqueue(enc.encode(s));
          };
          const finish = () => {
            if (closed) return;
            stop();
            try {
              controller.close();
            } catch {
              // 已被取消
            }
          };
          const u = await ctx.bus.subscribe(cardsTopic(who.orgId), (m) => {
            const change = parseChange(m);
            if (!change) return;
            // 与列表同一可见范围：组织页面只收不属于对话的卡片，对话标签只收本对话的
            if (change.conversationId !== (who.conversationId ?? null)) return;
            send(
              `event: cards\ndata: ${JSON.stringify({ cardId: change.cardId, status: change.status })}\n\n`,
            );
          });
          if (closed) {
            void u().catch(() => {});
            return;
          }
          unsubscribe = u;
          if (done.aborted) {
            finish();
            return;
          }
          done.addEventListener("abort", finish, { once: true });
          send("event: ready\ndata: {}\n\n");
          void (async () => {
            while (!closed) {
              await sleep(HEARTBEAT_MS, done);
              send(": ping\n\n");
            }
          })();
        },
        cancel() {
          stop();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        },
      });
    });
  },
});
