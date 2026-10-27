import { defineExtension, type EmbedClaims, type ExtensionContext } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { BOARD_HTML, BOARD_JS } from "./page.js";

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
const BEARER_RE = /^Bearer ([A-Za-z0-9._-]{1,4096})$/;
const MAX_CARDS = 200;
/** SSE 心跳间隔：中间层（Web 代理、负载均衡）不会把空闲连接掐断。 */
const HEARTBEAT_MS = 15_000;

const cardsTopic = (orgId: string) => `cards.${orgId}`;

const json = (status: number, body: unknown) => Response.json(body, { status });
const error = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });
const unauthorized = () => error(401, "unauthorized", "A valid embed token is required");

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
 * 令牌的可见范围：对话嵌入只看这个对话的卡片；组织页面只看不属于任何对话的卡片
 * （对话里的卡片只能经声明里有该对话的 board-conv 令牌看到，组织页面的令牌看不到也改不了）。
 */
// biome-ignore lint/suspicious/noExplicitAny: 插件自带表结构，Kysely 未声明类型
function scoped(q: any, claims: EmbedClaims): any {
  const byOrg = q.where("org_id", "=", claims.orgId);
  return claims.conversationId === undefined
    ? byOrg.where("conversation_id", "is", null)
    : byOrg.where("conversation_id", "=", claims.conversationId);
}

async function listCards(db: Db, claims: EmbedClaims): Promise<Card[]> {
  const rows = await scoped(
    db.selectFrom("cards").select(["id", "title", "status", "conversation_id"]),
    claims,
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
 * 第二档界面（嵌入应用）的参考插件：一个最小的「工作流进度看板」。
 * - 组织页面 `board`（顶栏「扩展」）与对话标签 `board-conv`，都是 iframe 里的插件页面；
 * - 每个数据路由先 `ctx.ui.verifyEmbedToken`，不通过 401；身份（组织、账号、对话）只从令牌声明里取；
 * - `/ui/events`（SSE）按请求订阅 `ctx.bus`，客户端断开或令牌过期时退订、结束（网页用续期后的令牌重连）；
 * - 不用定时器、不放模块级可变状态：跨副本的刷新全靠 bus。
 */
export default defineExtension({
  name: "example-board",
  version: "0.1.0",
  sdk: "^0.1.0",
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
      { method: "GET", path: "/ui/board" },
      { method: "GET", path: "/ui/board-conv" },
      { method: "GET", path: "/ui/board.js" },
      { method: "GET", path: "/ui/cards" },
      { method: "POST", path: "/ui/cards" },
      { method: "POST", path: "/ui/cards/:id" },
      { method: "GET", path: "/ui/events" },
    ],
    ui: { embeds: ["board", "board-conv"] },
  },
  setup(ctx) {
    const auth = async (req: Request): Promise<EmbedClaims | null> => {
      const m = BEARER_RE.exec(req.headers.get("authorization") ?? "");
      return m?.[1] === undefined ? null : ctx.ui.verifyEmbedToken(m[1]);
    };
    const publish = (orgId: string, change: CardChange) =>
      ctx.bus.publish(cardsTopic(orgId), change);

    // ---- 静态页面与脚本：不含数据，不要求令牌 ----
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

    // ---- 数据 ----
    ctx.http.route("GET", "/ui/cards", async (req) => {
      const claims = await auth(req);
      if (!claims) return unauthorized();
      return json(200, { cards: await listCards(ctx.db, claims) });
    });

    ctx.http.route("POST", "/ui/cards", async (req) => {
      const claims = await auth(req);
      if (!claims) return unauthorized();
      const input = await body(req, CreateBody);
      if (!input) return error(400, "validation_failed", "title must be 1-200 characters");
      const row = await ctx.db
        .insertInto("cards")
        .values({
          org_id: claims.orgId,
          conversation_id: claims.conversationId ?? null,
          title: input.title,
        })
        .returning(["id", "title", "status", "conversation_id"])
        .executeTakeFirstOrThrow();
      const card = toCard(row);
      await publish(claims.orgId, {
        cardId: card.id,
        status: card.status,
        conversationId: card.conversationId,
      });
      return json(201, { card });
    });

    ctx.http.route("POST", "/ui/cards/:id", async (req) => {
      const claims = await auth(req);
      if (!claims) return unauthorized();
      const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
      if (!UUID_RE.test(id)) return error(404, "not_found", "Card not found");
      const input = await body(req, MoveBody);
      if (!input) return error(400, "validation_failed", "status must be todo, doing or done");
      const row = await scoped(
        ctx.db
          .updateTable("cards")
          .set({ status: input.status, updated_at: new Date() })
          .where("id", "=", id),
        claims,
      )
        .returning(["id", "title", "status", "conversation_id"])
        .executeTakeFirst();
      if (!row) return error(404, "not_found", "Card not found");
      const card = toCard(row);
      await publish(claims.orgId, {
        cardId: card.id,
        status: card.status,
        conversationId: card.conversationId,
      });
      return json(200, { card });
    });

    // ---- 实时刷新：SSE，按请求订阅 bus ----
    ctx.http.route("GET", "/ui/events", async (req) => {
      const claims = await auth(req);
      if (!claims) return unauthorized();
      // 客户端断开或令牌过期即结束：过期后网页用续期的令牌重连，权限随令牌一起过期
      const done = AbortSignal.any([
        req.signal,
        AbortSignal.timeout(Math.max(1, claims.exp * 1000 - Date.now())),
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
          const u = await ctx.bus.subscribe(cardsTopic(claims.orgId), (m) => {
            const change = parseChange(m);
            if (!change) return;
            // 与列表同一可见范围：组织页面只收不属于对话的卡片，对话标签只收本对话的
            if (change.conversationId !== (claims.conversationId ?? null)) return;
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
