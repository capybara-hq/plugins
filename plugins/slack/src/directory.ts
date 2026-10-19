import type { Directory, DirectoryMember } from "@capybara-hq/plugin-sdk";
import { SlackDirectoryConfig } from "./config.js";

export interface SlackDirectoryOptions {
  /** Web API 根地址（默认 https://slack.com/api/；测试指向假 Slack）。 */
  apiUrl: string;
  /** 每页人数（`users.list` 的 `limit`；默认 200，Slack 建议不超过 200）。 */
  pageSize?: number;
  /** 单次请求超时（默认 15 秒）。 */
  requestTimeoutMs?: number;
  /** 429 时最多重试几次（默认 3）。 */
  maxRateLimitRetries?: number;
  /** 愿意按 Retry-After 等待的上限（默认 30 秒）；Slack 要求等得更久时直接抛错，本轮同步记为不完整。 */
  maxRateLimitWaitMs?: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** 可中止的等待：signal 中止时以其原因拒绝。 */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = AbortSignal.timeout(ms);
    const both = AbortSignal.any([signal, timer]);
    both.addEventListener("abort", () => (signal.aborted ? reject(signal.reason) : resolve()), {
      once: true,
    });
  });

/** Slackbot 的固定 user id：`users.list` 里它的 `is_bot` 为 false，要按 id 排除。 */
const SLACKBOT = "USLACKBOT";

/**
 * Slack 通讯录（`directory@1`）：`users.list` 分页列出工作区成员
 * （https://docs.slack.dev/reference/methods/users.list ，2026-10-20 查阅）。
 *
 * - 组织级配置 `{ teamId, botToken }`；机器人令牌需 `users:read` 与 `users:read.email`（没有后者拿不到邮箱）。
 * - 每页先 `auth.test`：令牌所属工作区（`team_id`）必须等于配置的 `teamId`，否则抛错——成员的 `tenantId`
 *   （身份键 `slack:<teamId>`）不能张冠李戴。`users.list` 也带 `team_id`（工作区令牌忽略它，组织级令牌必需）。
 * - 排除机器人（`is_bot`）与 Slackbot（`USLACKBOT`）；`deleted = true` → `active = false`。
 * - `emailVerified` 一律 false：`users.list` 文档没有说明 `profile.email` 是否经过验证（登录时 OIDC 的
 *   `email_verified` 才算数）。内核只对受信任租户合并账号，这里不放宽。
 * - 游标：`response_metadata.next_cursor`（空串表示最后一页）原样作 `next`。
 * - 限流：`users.list` 为 Tier 2（20+ 次/分钟）。HTTP 429 时按 `Retry-After` 在 signal 内等待后重试，最多
 *   `maxRateLimitRetries` 次；Retry-After 超过 `maxRateLimitWaitMs` 或重试用尽就抛错（内核把本轮记为不完整，
 *   不移除任何人），不会无限循环。
 * 错误消息只带错误码 / HTTP 状态，不带令牌。
 */
export function createSlackDirectory(opts: SlackDirectoryOptions): Directory {
  const pageSize = opts.pageSize ?? 200;
  const timeout = opts.requestTimeoutMs ?? 15_000;
  const maxRetries = opts.maxRateLimitRetries ?? 3;
  const maxWait = opts.maxRateLimitWaitMs ?? 30_000;

  async function call(
    method: string,
    token: string,
    form: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Obj> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let res: Response;
      try {
        res = await fetch(new URL(method, opts.apiUrl), {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Bearer ${token}`,
          },
          body: new URLSearchParams(form).toString(),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
        });
      } catch (e) {
        signal.throwIfAborted();
        throw new Error(`Slack ${method} failed: network error`, { cause: e });
      }
      if (res.status === 429) {
        await res.body?.cancel();
        const retryAfter = Number(res.headers.get("retry-after") ?? "1");
        const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 1000;
        if (attempt >= maxRetries || waitMs > maxWait) {
          throw new Error(
            `Slack ${method} rate limited (retry after ${retryAfter}s); the sync will be retried later`,
          );
        }
        await pause(waitMs, signal);
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new Error(`Slack ${method} failed: HTTP ${res.status}`);
      }
      const body = obj(await res.json().catch(() => undefined));
      if (body?.ok !== true) {
        throw new Error(`Slack ${method} failed: ${str(body?.error) ?? "malformed response"}`);
      }
      return body;
    }
  }

  return {
    async listMembers({ orgConfig, cursor, signal }) {
      const c = SlackDirectoryConfig.parse(orgConfig ?? {});
      if (c.teamId === undefined || c.botToken === undefined) {
        throw new Error(
          "Slack directory is not configured: set teamId and botToken in the organization config",
        );
      }
      const teamId = c.teamId;
      const auth = await call("auth.test", c.botToken, {}, signal);
      const tokenTeam = str(auth.team_id);
      if (tokenTeam !== teamId) {
        throw new Error(
          `Slack bot token belongs to team ${tokenTeam ?? "(unknown)"}, not the configured teamId ${teamId}`,
        );
      }
      const page = await call(
        "users.list",
        c.botToken,
        {
          limit: String(pageSize),
          team_id: teamId,
          ...(cursor !== undefined && { cursor }),
        },
        signal,
      );
      if (!Array.isArray(page.members)) {
        throw new Error("Slack users.list failed: no members array");
      }
      const members: DirectoryMember[] = [];
      for (const raw of page.members) {
        const u = obj(raw);
        const id = str(u?.id);
        if (!u || !id || id === SLACKBOT || u.is_bot === true) continue;
        const profile = obj(u.profile);
        const email = str(profile?.email);
        members.push({
          externalId: id,
          tenantId: teamId,
          ...(email !== undefined && { email }),
          emailVerified: false,
          displayName:
            str(profile?.display_name) ??
            str(profile?.real_name) ??
            str(u.real_name) ??
            str(u.name) ??
            id,
          active: u.deleted !== true,
        });
      }
      const next = str(obj(page.response_metadata)?.next_cursor);
      return { members, ...(next !== undefined && { next }) };
    },
  };
}
