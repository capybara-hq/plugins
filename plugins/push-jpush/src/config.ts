import { secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** JPush's REST host (https://docs.jiguang.cn/jpush/server/push/server_overview). */
export const JPUSH_API = "https://api.jpush.cn";

const label = (en: string, zh: string) => ({ label: { en, zh } });
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

/**
 * The platform deployment config, as JPush names things. `appKey` and `masterSecret` come from the
 * JPush console (app settings); `applicationIds` lists the Android application ids of the app
 * builds that integrate this JPush app (`apps()` returns them).
 *
 * The vendor objects are optional and only carry what the deployer obtained from each vendor for
 * the service (non-marketing) classification of notifications (README, "Vendor channels"):
 * Xiaomi's private-message channel and template, OPPO's channel / category / notify level, vivo's
 * category and template, Huawei's category (needs Huawei's self-classification entitlement).
 * Templates must declare the variables `title` and `body`.
 */
export const JPushDeployment = z.object({
  appKey: ui(z.string().trim().min(1).max(64), label("AppKey", "AppKey")),
  masterSecret: ui(
    secret(z.string().trim().min(1).max(256)),
    label("Master Secret", "Master Secret"),
  ),
  applicationIds: ui(
    z
      .array(
        z
          .string()
          .min(1)
          .max(255)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be an Android application id"),
      )
      .min(1),
    label("Android application ids", "Android 应用 ID（包名）"),
  ),
  xiaomi: ui(
    z
      .object({
        channelId: ui(optionalText(64), label("Channel id", "通道 ID")),
        templateId: ui(optionalText(128), label("Template id", "模板 ID")),
      })
      .optional(),
    label("Xiaomi", "小米"),
  ),
  oppo: ui(
    z
      .object({
        channelId: ui(optionalText(64), label("Channel id", "通道 ID")),
        category: ui(optionalText(64), label("Category", "消息分类")),
        notifyLevel: ui(
          z.union([z.literal(1), z.literal(2), z.literal(16)]).optional(),
          label("Notify level", "提醒等级"),
        ),
      })
      .refine((o) => o.notifyLevel === undefined || o.category !== undefined, {
        message: "oppo.notifyLevel needs oppo.category",
      })
      .optional(),
    label("OPPO", "OPPO"),
  ),
  vivo: ui(
    z
      .object({
        category: ui(optionalText(64), label("Category", "消息分类")),
        templateId: ui(optionalText(128), label("Template id", "模板 ID")),
      })
      .optional(),
    label("vivo", "vivo"),
  ),
  huawei: ui(
    z
      .object({
        category: ui(optionalText(64), label("Category", "消息分类")),
      })
      .optional(),
    label("Huawei", "华为"),
  ),
});
export type JPushDeploymentConfig = z.infer<typeof JPushDeployment>;
