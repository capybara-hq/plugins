import { type ClientOptions, OpenAI as SdkOpenAI } from "openai";

/** Client options with the key and base URL always given (never the SDK's env defaults). */
export type IsolatedClientOptions = Omit<ClientOptions, "apiKey" | "baseURL"> & {
  apiKey: string;
  baseURL: string;
};

/**
 * The `openai` SDK client with nothing taken from the host environment. The SDK defaults the key,
 * admin key, organization, project, webhook secret and base URL to OPENAI_* env vars, and merges
 * OPENAI_CUSTOM_HEADERS into the default headers of every request, after the Authorization header
 * (so it can even replace the key). An org may point the client at its own URL, so every
 * env-backed option is explicit here and the default headers are reset to exactly the caller's.
 * Named `OpenAI` so the SDK's User-Agent (`<class name>/JS <version>`) stays the same.
 */
class OpenAI extends SdkOpenAI {
  constructor(opts: IsolatedClientOptions) {
    for (const key of ["apiKey", "baseURL"] as const) {
      const value: unknown = opts[key];
      if (typeof value !== "string" || value === "") {
        throw new Error(`isolatedOpenAI: ${key} must be a non-empty string`);
      }
    }
    // After the spread: an explicit `undefined` would bring back the SDK's env default
    super({
      ...opts,
      organization: opts.organization ?? null,
      project: opts.project ?? null,
      adminAPIKey: opts.adminAPIKey ?? null,
      webhookSecret: opts.webhookSecret ?? null,
    });
    this._options = { ...this._options, defaultHeaders: opts.defaultHeaders };
  }
}

/** A per-call `openai` client that reads no OPENAI_* env var (see the class above). */
export function isolatedOpenAI(opts: IsolatedClientOptions): SdkOpenAI {
  return new OpenAI(opts);
}
