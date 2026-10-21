import { createHash } from "node:crypto";
import type { Directory, DirectoryMember } from "@capybara-hq/plugin-sdk";
import { createLarkApi, type LarkCredentials } from "./api.js";
import { getWithBackoff, type RateLimitBudget } from "./backoff.js";
import { LarkOrgConfig } from "./config.js";
import { assertSameApp, tenantKeyOf } from "./tenant.js";

export interface LarkDirectoryOptions {
  /** 开放平台根地址（默认 https://open.larksuite.com；测试指向假 Lark）。 */
  apiUrl: string;
  /** 部署级网页登录的应用（配了时核对同一租户的通讯录用的是同一个应用）。 */
  loginApp?: LarkCredentials;
  /** 每页人数（`find_by_department` 的 `page_size`；默认 50，Lark 上限 50）。 */
  pageSize?: number;
  /** 单次请求超时（默认 15 秒）。 */
  requestTimeoutMs?: number;
  /** 限流时最多重试几次（每次请求；默认 3）。 */
  maxRateLimitRetries?: number;
  /**
   * 每次 `listMembers`（一页）内按 `x-ogw-ratelimit-reset` 累计等待的预算（默认 30 秒）；下一次等待超出剩余预算就
   * 直接抛错，本轮同步记为不完整。
   */
  maxRateLimitWaitMs?: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** 根部门的部门 id（文档：「根部门的部门ID为0」）。 */
const ROOT = "0";
/** 部门列表每页数量（Lark 上限 50）。 */
const DEPT_PAGE_SIZE = 50;
/** 连续空的部门页最多跳过几页（防御：平台返回 has_more 却没有条目时不无限循环）。 */
const MAX_EMPTY_DEPT_PAGES = 20;
/** 最后一页重列部门时最多翻几页（50 × 2000 = 10 万个部门）。 */
const MAX_DEPT_PAGES = 2000;

/** 已访问部门的累积摘要：`h' = sha256(h + "\n" + 部门 id)`（截短；只用于比对顺序与集合是否一致）。 */
const chain = (prev: string, id: string) =>
  createHash("sha256").update(`${prev}\n${id}`).digest("base64url").slice(0, 22);
const ROOT_DIGEST = chain("", "0");

/**
 * 游标（base64url JSON，对内核不透明）：`t` 本轮的租户；`di` 当前部门在部门页里的下标（-1 = 根部门）；`dp` 当前
 * 部门页的 page_token（第一页省略）；`dd` 当前部门的 id（续页时核对部门列表没变）；`up` 该部门用户列表的 page_token；
 * `h` 到当前部门为止（含根部门与当前部门）按访问顺序的累积摘要（最后一页与重列的部门比对）。
 */
interface Cursor {
  t: string;
  di: number;
  h: string;
  dp?: string;
  dd?: string;
  up?: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(s: string): Cursor {
  let v: Obj | undefined;
  try {
    v = obj(JSON.parse(Buffer.from(s, "base64url").toString("utf8")));
  } catch {
    v = undefined;
  }
  const t = str(v?.t);
  const h = str(v?.h);
  const di = v?.di;
  if (
    !v ||
    t === undefined ||
    h === undefined ||
    typeof di !== "number" ||
    !Number.isInteger(di) ||
    di < -1 ||
    (di >= 0 && str(v.dd) === undefined) ||
    (v.dp !== undefined && str(v.dp) === undefined) ||
    (v.up !== undefined && str(v.up) === undefined)
  ) {
    throw new Error("Lark directory cursor is malformed");
  }
  return {
    t,
    di,
    h,
    ...(str(v.dp) !== undefined && { dp: str(v.dp) as string }),
    ...(str(v.dd) !== undefined && { dd: str(v.dd) as string }),
    ...(str(v.up) !== undefined && { up: str(v.up) as string }),
  };
}

/**
 * Lark 通讯录（`directory@1`；文档均 2026-10-20 查阅）。
 *
 * Lark 没有「列出全部用户」的接口：用户列表只能按部门取**直属**成员，所以遍历「根部门 + 全部子部门」：
 * - 子部门（https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/children ）：
 *   `GET /open-apis/contact/v3/departments/0/children?fetch_child=true`（递归），`page_size` 最大 50，
 *   `page_token` / `has_more`。tenant token 下部门 id 为 0 时校验应用是否有**全员**通讯录权限。
 * - 部门直属用户（https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/find_by_department ）：
 *   `GET /open-apis/contact/v3/users/find_by_department?department_id=…`（根部门为 `0`），`page_size` 最大 50；
 *   `user_id_type=open_id`（`open_id` 按应用区分，与登录、机器人同一应用时三处一致）。权限任选其一
 *   `contact:contact.base:readonly` / `contact:contact:readonly_as_app` / …；字段：`name` / `en_name` / `nickname`
 *   需 `contact:user.base:readonly`（或 `readonly_as_app`），`email` 需 `contact:user.email:readonly`，
 *   `enterprise_email` 与 `status` 需 `contact:user.employee:readonly`（或 `readonly_as_app`）。
 * - 用户状态（https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/field-overview ）：
 *   `status.is_frozen`（暂停）、`is_resigned`（离职）、`is_activated`（激活）、`is_exited`（主动退出，一段时间后转为
 *   离职）、`is_unjoin`（未加入，需本人确认）。
 * - 频控：两个接口都是 1000 次/分钟、50 次/秒；超限 HTTP 429 + `99991400`，`x-ogw-ratelimit-reset` 为建议等待秒数
 *   （https://open.larksuite.com/document/ukTMukTMukTM/uUzN04SN3QjL1cDN ）。
 *
 * 行为：
 * - 组织级配置 `{ appId, appSecret }`；`configured()`：两项都填了才算配置好，否则内核静默跳过同步（Ruling A28）；
 *   未配置时 `listMembers` 抛错（不返回空列表——空列表在手动同步时会把成员全部移除）。
 * - 每页先查企业信息拿 `tenant_key`：成员的 `tenantId` 一律是它（与渠道 verify、登录同一口径，身份键
 *   `lark:<tenant_key>`）；游标里记下第一页的租户，之后每页核对，不同就抛错（应用凭据途中被换成别的租户）。
 *   部署配了网页登录且是同一租户的另一个应用时抛错（见 {@link assertSameApp}）。
 * - 一页 = 一个部门的一页用户。顺序：根部门直属成员，然后按部门列表逐个部门。部门列表途中变了就抛错（本轮按不完整
 *   处理、不移除任何人），不会悄悄漏掉一个部门：续页时核对游标里的部门 id 仍在原位；游标还带着按访问顺序累积的
 *   部门摘要，**最后一页**重列全部部门、算同样的摘要，不同就抛错——能发现「已访问的部门与未访问的对调、当前位置
 *   没变」这类逐页核对看不出的变化。同一人属于多个部门时会在多页出现（内核按身份去重，幂等）；同一页内去重。
 * - 状态：离职、冻结、主动退出 → `active: false`。**未激活**（`is_activated = false`，受邀但还没激活）与**未加入**
 *   （`is_unjoin`）的人不同步：他们还不能登录或使用 Lark，等激活后下一轮同步再加入。没有 `status` 字段（缺少
 *   字段权限）时抛错，而不是把所有人当在职——否则离职的人永远不会被移除。
 * - 机器人 / 应用不是通讯录用户：这两个接口只返回成员，不会出现机器人，无需排除（没有 `open_id` 的条目跳过）。
 * - `emailVerified` 一律 false：文档没有说明 `email` / `enterprise_email` 是否经过验证。邮箱取 `email`，没有时取
 *   `enterprise_email`。显示名 `name → en_name → nickname → open_id`。
 * - 限流：每次请求（含企业信息与登录应用的租户核对）遇到 429 / `99991400` 时按 `x-ogw-ratelimit-reset`（没有则
 *   1 秒）在 signal 内等待后重试，最多 `maxRateLimitRetries` 次，一页内累计等待不超过 `maxRateLimitWaitMs`
 *   （默认 30 秒）；超出就抛「rate limited」，不会无限循环。
 * 错误消息只带步骤与错误码，不带 App Secret 或 token。
 */
export function createLarkDirectory(opts: LarkDirectoryOptions): Directory {
  const api = createLarkApi({ baseUrl: opts.apiUrl, timeoutMs: opts.requestTimeoutMs ?? 15_000 });
  const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? 50));
  const maxRetries = opts.maxRateLimitRetries ?? 3;
  const maxWait = opts.maxRateLimitWaitMs ?? 30_000;

  /** 带限流退避的 GET（tenant token）。 */
  const get = (
    creds: LarkCredentials,
    path: string,
    query: Record<string, string>,
    what: string,
    signal: AbortSignal,
    budget: RateLimitBudget,
  ) => getWithBackoff(api, creds, path, { query, what, signal, budget, maxRetries });

  /** 一页子部门（递归）：部门 id 列表与下一页的 page_token。 */
  async function departmentPage(
    creds: LarkCredentials,
    pageToken: string | undefined,
    signal: AbortSignal,
    budget: RateLimitBudget,
  ): Promise<{ ids: string[]; next?: string }> {
    const r = await get(
      creds,
      `/open-apis/contact/v3/departments/${ROOT}/children`,
      {
        fetch_child: "true",
        department_id_type: "open_department_id",
        user_id_type: "open_id",
        page_size: String(DEPT_PAGE_SIZE),
        ...(pageToken !== undefined && { page_token: pageToken }),
      },
      "department list (needs contact scope for all members)",
      signal,
      budget,
    );
    const data = obj(r.data);
    const items = Array.isArray(data?.items) ? data.items : [];
    const ids = items.map((d) => str(obj(d)?.open_department_id)).filter((x) => x !== undefined);
    const next = data?.has_more === true ? str(data.page_token) : undefined;
    return { ids, ...(next !== undefined && { next }) };
  }

  /**
   * 从部门页 `dp` 的第 `from` 个部门起，找下一个部门的游标（摘要接在 `h` 后面）；没有了返回 undefined。
   */
  async function nextDepartment(
    creds: LarkCredentials,
    tenant: string,
    start: { dp?: string; page?: { ids: string[]; next?: string }; from: number; h: string },
    signal: AbortSignal,
    budget: RateLimitBudget,
  ): Promise<Cursor | undefined> {
    let dp = start.dp;
    let page = start.page ?? (await departmentPage(creds, dp, signal, budget));
    let from = start.from;
    for (let empty = 0; ; ) {
      const id = page.ids[from];
      if (id !== undefined) {
        return {
          t: tenant,
          di: from,
          dd: id,
          h: chain(start.h, id),
          ...(dp !== undefined && { dp }),
        };
      }
      if (page.next === undefined || page.next === dp) return undefined;
      if (page.ids.length === 0 && ++empty > MAX_EMPTY_DEPT_PAGES) {
        throw new Error("Lark department list returned too many empty pages");
      }
      dp = page.next;
      page = await departmentPage(creds, dp, signal, budget);
      from = 0;
    }
  }

  /** 重列全部部门，算出完整走一遍时最后一页游标应有的摘要。 */
  async function fullDigest(
    creds: LarkCredentials,
    signal: AbortSignal,
    budget: RateLimitBudget,
  ): Promise<string> {
    let h = ROOT_DIGEST;
    let dp: string | undefined;
    for (let n = 0; ; n++) {
      if (n >= MAX_DEPT_PAGES) throw new Error("Lark department list has too many pages");
      const page = await departmentPage(creds, dp, signal, budget);
      for (const id of page.ids) h = chain(h, id);
      if (page.next === undefined || page.next === dp) return h;
      dp = page.next;
    }
  }

  return {
    configured(orgConfig) {
      const r = LarkOrgConfig.safeParse(orgConfig ?? {});
      return r.success && r.data.appId !== undefined && r.data.appSecret !== undefined;
    },

    async listMembers({ orgConfig, cursor, signal }) {
      const c = LarkOrgConfig.parse(orgConfig ?? {});
      if (c.appId === undefined || c.appSecret === undefined) {
        throw new Error(
          "Lark directory is not configured: set appId and appSecret in the organization config",
        );
      }
      const creds = { appId: c.appId, appSecret: c.appSecret };
      const budget: RateLimitBudget = { leftMs: maxWait };
      const cur = cursor !== undefined ? decodeCursor(cursor) : undefined;

      const tenant = await tenantKeyOf(api, creds, signal, budget);
      if (cur !== undefined && cur.t !== tenant) {
        throw new Error(
          `Lark app now belongs to tenant ${tenant}, not ${cur.t} as earlier in this sync`,
        );
      }
      await assertSameApp(api, opts.loginApp, creds.appId, tenant, signal, budget);

      const at: Cursor = cur ?? { t: tenant, di: -1, h: ROOT_DIGEST };
      let deptId = ROOT;
      let deptPage: { ids: string[]; next?: string } | undefined;
      if (at.di >= 0) {
        deptPage = await departmentPage(creds, at.dp, signal, budget);
        const id = deptPage.ids[at.di];
        if (id === undefined || id !== at.dd) {
          throw new Error(
            "Lark department list changed during the sync; the sync will be retried later",
          );
        }
        deptId = id;
      }

      const r = await get(
        creds,
        "/open-apis/contact/v3/users/find_by_department",
        {
          department_id: deptId,
          department_id_type: "open_department_id",
          user_id_type: "open_id",
          page_size: String(pageSize),
          ...(at.up !== undefined && { page_token: at.up }),
        },
        "user list (needs contact scope for all members)",
        signal,
        budget,
      );
      const data = obj(r.data);
      if (data !== undefined && data.items !== undefined && !Array.isArray(data.items)) {
        throw new Error("Lark user list returned no items array");
      }
      const items: unknown[] = Array.isArray(data?.items) ? data.items : [];

      const members: DirectoryMember[] = [];
      const seen = new Set<string>();
      for (const raw of items) {
        const u = obj(raw);
        const openId = str(u?.open_id);
        if (!u || openId === undefined || seen.has(openId)) continue;
        seen.add(openId);
        const status = obj(u.status);
        if (!status) {
          throw new Error(
            "Lark user list has no status field; grant contact:user.employee:readonly (or contact:contact:readonly_as_app) so resigned users can be detected",
          );
        }
        const inactive =
          status.is_resigned === true || status.is_frozen === true || status.is_exited === true;
        if (!inactive && (status.is_activated === false || status.is_unjoin === true)) continue;
        const email = str(u.email) ?? str(u.enterprise_email);
        members.push({
          externalId: openId,
          tenantId: tenant,
          ...(email !== undefined && { email }),
          emailVerified: false,
          displayName: str(u.name) ?? str(u.en_name) ?? str(u.nickname) ?? openId,
          active: !inactive,
        });
      }

      const userNext = data?.has_more === true ? str(data.page_token) : undefined;
      let next: Cursor | undefined;
      if (userNext !== undefined && userNext !== at.up) {
        next = { ...at, up: userNext };
      } else if (at.di < 0) {
        next = await nextDepartment(creds, tenant, { from: 0, h: at.h }, signal, budget);
      } else {
        next = await nextDepartment(
          creds,
          tenant,
          {
            ...(at.dp !== undefined && { dp: at.dp }),
            ...(deptPage && { page: deptPage }),
            from: at.di + 1,
            h: at.h,
          },
          signal,
          budget,
        );
      }
      if (next === undefined && (await fullDigest(creds, signal, budget)) !== at.h) {
        throw new Error(
          "Lark department list changed during the sync; the sync will be retried later",
        );
      }
      return { members, ...(next !== undefined && { next: encodeCursor(next) }) };
    },
  };
}
