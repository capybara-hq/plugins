import { z } from "zod";

/** 文档（specText 或从 specUrl 取到的）最大字节数。 */
export const MAX_SPEC_BYTES = 2 * 1024 * 1024;

/**
 * Whether a URL may be configured: http or https. Whether the target is reachable is decided by the
 * kernel's `ctx.net` at request time (https to public addresses; plain http and internal addresses
 * only for an endpoint a super admin allowed for the org).
 */
export function urlAllowed(u: URL): boolean {
  return u.protocol === "https:" || u.protocol === "http:";
}

const URL_RULE = "URL must use http or https";

const parsesAllowed = (raw: string): boolean => {
  try {
    return urlAllowed(new URL(raw));
  } catch {
    return true; // z.url() reports the format error
  }
};

/**
 * The endpoint: exactly one of `specUrl` (the document, fetched without credentials) and `specText`
 * (the document itself, JSON or YAML, at most 2 MB); `baseUrl` overrides the document's `servers`;
 * `operations` are the selected operation ids (default: all). URLs are http or https (ctx.net
 * decides reachability at request time).
 */
export function endpointSchema() {
  const url = () => z.url().max(2000).refine(parsesAllowed, { message: URL_RULE });
  return z
    .object({
      specUrl: url().optional(),
      specText: z
        .string()
        .min(1)
        .refine((v) => Buffer.byteLength(v, "utf8") <= MAX_SPEC_BYTES, {
          message: "The OpenAPI document must be at most 2 MB",
        })
        .optional(),
      baseUrl: url().optional(),
      operations: z.array(z.string().min(1).max(200)).min(1).max(1000).optional(),
    })
    .strict()
    .superRefine((e, ctx) => {
      if ((e.specUrl === undefined) === (e.specText === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["specUrl"],
          message: "Provide exactly one of specUrl and specText",
        });
      }
    });
}

export type OpenApiEndpoint = z.infer<ReturnType<typeof endpointSchema>>;

/** The document's server / the baseUrl is not usable (model-visible, English). */
export const SERVER_URL_TEXT = `The API base URL is not allowed: ${URL_RULE}. Ask an administrator to set the app's baseUrl to an http or https URL.`;
