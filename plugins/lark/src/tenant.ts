import type { LarkApi, LarkCredentials } from "./api.js";
import { describeError } from "./errors.js";

/**
 * 应用所在租户的 `tenant_key`：企业信息接口
 * （https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/tenant-v2/tenant/query ，2026-10-20 查阅；
 * `GET /open-apis/tenant/v2/tenant/query`，tenant token，需要权限 `tenant:tenant:readonly`）。机器人信息与 token
 * 接口都不给 tenant_key，这是唯一的来源。渠道 verify、网页登录的租户核对、通讯录成员的租户都用它，三处同一口径。
 */
export async function tenantKeyOf(
  api: LarkApi,
  creds: LarkCredentials,
  signal: AbortSignal,
): Promise<string> {
  try {
    const r = await api.call<{ data?: { tenant?: { tenant_key?: unknown } } }>(
      creds,
      "/open-apis/tenant/v2/tenant/query",
      { signal },
    );
    const k = r.data?.tenant?.tenant_key;
    if (typeof k !== "string" || k === "") throw new Error("no tenant_key");
    return k;
  } catch (e) {
    signal.throwIfAborted();
    throw describeError(e, "tenant query (needs scope tenant:tenant:readonly)");
  }
}

/**
 * 登录、机器人、通讯录必须用同一个 Lark 应用：`open_id` 按应用区分（「同一个用户在不同应用中的 Open ID 不同」，
 * https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/find_by_department ，
 * 2026-10-20 查阅），换个应用同一个人的 `open_id` 就不同，身份行就对不上（同一个人会变成两个账号）。
 *
 * 部署配了网页登录的应用（`loginApp`）且与本应用不同时，查登录应用的租户：与本应用同一租户 → 抛错。登录应用的
 * 凭据取不到租户（错的、或属于别的部署环境）时不拦——那时登录本身就不可用，也就不会产生对不上的身份。
 */
export async function assertSameApp(
  api: LarkApi,
  loginApp: LarkCredentials | undefined,
  appId: string,
  tenantKey: string,
  signal: AbortSignal,
): Promise<void> {
  if (loginApp === undefined || loginApp.appId === appId) return;
  let loginTenant: string;
  try {
    loginTenant = await tenantKeyOf(api, loginApp, signal);
  } catch {
    signal.throwIfAborted();
    return;
  }
  if (loginTenant === tenantKey) {
    throw new Error(
      `Lark app ${appId} is not the deployment's login app ${loginApp.appId}, but both belong to tenant ${tenantKey}; use the same Lark app for login, bot and directory (open_id differs per app)`,
    );
  }
}
