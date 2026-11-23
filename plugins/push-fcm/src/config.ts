import { createPrivateKey } from "node:crypto";
import { platformOnly, secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** The fields push-fcm uses from a Google service account key file. */
export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const REQUIRED = ["project_id", "client_email", "private_key"] as const; // capybara:allow-module-state read-only field list

/**
 * Reads a service account key file (the JSON text Firebase hands out): the parsed fields, or the
 * problem as an English sentence. The problem names fields only, never a value of the file.
 */
export function parseServiceAccount(text: string): ServiceAccount | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: "the service account is not JSON: paste the whole key file" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { problem: "the service account must be a JSON object (the whole key file)" };
  }
  const o = parsed as Record<string, unknown>;
  const missing = REQUIRED.filter(
    (k) => typeof o[k] !== "string" || (o[k] as string).trim() === "",
  );
  if (missing.length > 0) {
    return { problem: `the service account JSON lacks ${missing.join(", ")}` };
  }
  const privateKey = o.private_key as string;
  try {
    createPrivateKey(privateKey);
  } catch {
    return { problem: "the service account's private_key is not a PEM private key" };
  }
  return {
    projectId: o.project_id as string,
    clientEmail: o.client_email as string,
    privateKey,
  };
}

/** Deployment config (platform only; push providers have no org config). */
export const FcmDeployment = platformOnly(
  z.object({
    serviceAccount: secret(
      ui(
        z
          .string()
          .min(1)
          .superRefine((value, ctx) => {
            const r = parseServiceAccount(value);
            if ("problem" in r) ctx.addIssue({ code: "custom", message: r.problem });
          }),
        {
          label: { zh: "服务账号密钥（JSON）", en: "Service account key (JSON)" },
          help: {
            zh: "Firebase 控制台 → 项目设置 → 服务账号 → 生成新的私钥，把下载的 JSON 文件整个粘贴进来。",
            en: "Firebase console → Project settings → Service accounts → Generate new private key; paste the whole downloaded JSON file.",
          },
        },
      ),
    ),
    applicationIds: ui(z.array(z.string().min(1)).min(1), {
      label: { zh: "Android 应用 ID", en: "Android application ids" },
      help: {
        zh: "这个 Firebase 项目里注册的应用 ID（如 com.example.app）。",
        en: "The application ids registered in this Firebase project (such as com.example.app).",
      },
      widget: "tags",
    }),
  }),
);
export type FcmDeploymentConfig = z.infer<typeof FcmDeployment>;
