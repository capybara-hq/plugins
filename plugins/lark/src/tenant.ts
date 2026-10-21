import { type LarkApi, LarkApiError, type LarkCredentials } from "./api.js";
import { getWithBackoff, newBudget, type RateLimitBudget } from "./backoff.js";

/**
 * 应用所在租户的 `tenant_key`：企业信息接口
 * （https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/tenant-v2/tenant/query ，2026-10-20 查阅；
 * `GET /open-apis/tenant/v2/tenant/query`，tenant token，需要权限 `tenant:tenant:readonly`）。机器人信息与 token
 * 接口都不给 tenant_key，这是唯一的来源。渠道 verify / connect、网页登录的租户核对、通讯录成员的租户都用它，三处
 * 同一口径。限流时按 {@link getWithBackoff} 退避（`budget` 缺省为本次调用自己的 30 秒）。
 */
export async function tenantKeyOf(
  api: LarkApi,
  creds: LarkCredentials,
  signal: AbortSignal,
  budget: RateLimitBudget = newBudget(),
): Promise<string> {
  const r = await getWithBackoff(api, creds, "/open-apis/tenant/v2/tenant/query", {
    what: "tenant query (needs scope tenant:tenant:readonly)",
    signal,
    budget,
  });
  const data = r.data as { tenant?: { tenant_key?: unknown } } | undefined;
  const k = data?.tenant?.tenant_key;
  if (typeof k !== "string" || k === "") {
    throw new Error(
      "Lark tenant query (needs scope tenant:tenant:readonly) returned no tenant_key",
    );
  }
  return k;
}

/** 凭据本身无效：10014（app 不存在 / 不可用）、10015（App Secret 错误）——见 api.ts 取 token 的错误。 */
const CREDENTIALS_INVALID: Record<number, true> = { 10014: true, 10015: true };

/**
 * 登录、机器人、通讯录必须用同一个 Lark 应用：`open_id` 按应用区分（「同一个用户在不同应用中的 Open ID 不同」，
 * https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/find_by_department ，
 * 2026-10-20 查阅），换个应用同一个人的 `open_id` 就不同，身份行就对不上（同一个人会变成两个账号）。
 *
 * 部署配了网页登录的应用（`loginApp`）且与本应用不同时，查登录应用的租户（同样限流退避）：与本应用同一租户 → 抛错。
 * **只有**登录应用的凭据本身无效（10014 / 10015）时放行——那时登录本身不可用，也就不会产生对不上的身份；限流、
 * 网络、平台错误等暂时性失败一律抛错（不放行），由调用方稍后重试。
 */
export async function assertSameApp(
  api: LarkApi,
  loginApp: LarkCredentials | undefined,
  appId: string,
  tenantKey: string,
  signal: AbortSignal,
  budget: RateLimitBudget = newBudget(),
): Promise<void> {
  if (loginApp === undefined || loginApp.appId === appId) return;
  let loginTenant: string;
  try {
    loginTenant = await tenantKeyOf(api, loginApp, signal, budget);
  } catch (e) {
    signal.throwIfAborted();
    const cause = (e as { cause?: unknown }).cause;
    if (
      cause instanceof LarkApiError &&
      cause.code !== undefined &&
      CREDENTIALS_INVALID[cause.code]
    ) {
      return;
    }
    throw new Error(
      `cannot check that Lark app ${appId} is the deployment's login app: ${(e as Error).message}`,
      { cause: e },
    );
  }
  if (loginTenant === tenantKey) {
    throw new Error(
      `Lark app ${appId} is not the deployment's login app ${loginApp.appId}, but both belong to tenant ${tenantKey}; use the same Lark app for login, bot and directory (open_id differs per app)`,
    );
  }
}
