import { ModelError, orgAccess, secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { REGIONS, type Region } from "./tables.js";

/**
 * Deployment config. Every field is org-overridable (design B §5.5), so the platform's copy may
 * lack the key: it is required per call (not at load) and read from the per-call `opts.config`.
 */
export const DeploymentConfig = z.object({
  apiKey: orgAccess(
    ui(secret(z.string().min(1).optional()), { label: { zh: "API 密钥", en: "API key" } }),
    "override",
  ),
  region: orgAccess(
    ui(z.enum(REGIONS).default("cn-beijing"), {
      label: { zh: "地域", en: "Region" },
    }),
    "override",
  ),
  workspaceId: orgAccess(
    ui(
      // Becomes part of the host name: letters, digits and dashes only
      z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/)
        .optional(),
      {
        label: { zh: "业务空间 ID", en: "Workspace ID" },
        help: {
          zh: "除美国（弗吉尼亚）外的地域必填；北京地域不填时使用 dashscope.aliyuncs.com",
          en: "Required outside US (Virginia); without it Beijing uses dashscope.aliyuncs.com",
        },
      },
    ),
    "override",
  ),
});

/** Defaults the provider is built with (from `ctx.config` at setup), used only without `opts.config`. */
export interface BailianDefaults {
  apiKey?: string | undefined;
  region?: Region | undefined;
  workspaceId?: string | undefined;
  /**
   * The API origin, for tests (a fake server). Not a config field, so neither the platform nor an
   * org can set it; it replaces the origin derived from region and workspace.
   */
  baseUrl?: string | undefined;
}

/** Where and with which key one call goes. */
export interface Target {
  apiKey: string;
  baseUrl: string;
}

/**
 * The API origin of a region. `us-east-1` has one shared host without a workspace; the other
 * regions use the workspace host `https://{workspaceId}.{region}.maas.aliyuncs.com`. Without a
 * workspace, Beijing falls back to the shared domain `dashscope.aliyuncs.com`, which lists, chats
 * and embeds with a Beijing key (live 2026-11-08). The international shared domain could not be
 * checked (no Singapore key), so the other regions require the workspace id.
 */
export function baseUrlFor(region: Region, workspaceId: string | undefined): string {
  if (region === "us-east-1") return "https://dashscope-us.aliyuncs.com";
  if (workspaceId !== undefined && workspaceId !== "") {
    return `https://${workspaceId}.${region}.maas.aliyuncs.com`;
  }
  if (region === "cn-beijing") return "https://dashscope.aliyuncs.com";
  throw new ModelError("invalid_request", `Bailian: workspaceId is required for ${region}`);
}

/**
 * A cleared field may arrive as "" (or blanks): an empty `apiKey` is a missing key (`auth`), an
 * empty `workspaceId` an absent one, an empty `region` the default.
 */
function withoutEmptyFields(config: unknown): unknown {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return config;
  return Object.fromEntries(
    Object.entries(config).filter(([, v]) => !(typeof v === "string" && v.trim() === "")),
  );
}

/**
 * The key and origin of one call. The config is resolved as a whole, never per field: with
 * `opts.config` (the org's effective config; an org's copy deliberately comes without the
 * platform's secrets) only its values count, so the platform key never reaches a host derived
 * from an org's region or workspace. The setup defaults serve only a call without a config (the
 * conformance suite). No key is `auth`, before any request.
 */
export function resolveTarget(defaults: BailianDefaults, config: unknown): Target {
  let apiKey: string | undefined;
  let region: Region;
  let workspaceId: string | undefined;
  if (config === undefined) {
    ({ apiKey, workspaceId } = defaults);
    region = defaults.region ?? "cn-beijing";
  } else {
    const parsed = DeploymentConfig.safeParse(withoutEmptyFields(config));
    if (!parsed.success) {
      throw new ModelError("invalid_request", "Bailian: the extension config is invalid");
    }
    ({ apiKey, region, workspaceId } = parsed.data);
  }
  if (apiKey === undefined || apiKey === "") {
    throw new ModelError("auth", "Bailian: no API key is configured");
  }
  const baseUrl = defaults.baseUrl ?? baseUrlFor(region, workspaceId);
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}
