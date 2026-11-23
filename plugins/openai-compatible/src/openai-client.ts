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
    super({ organization: null, project: null, adminAPIKey: null, webhookSecret: null, ...opts });
    this._options = { ...this._options, defaultHeaders: opts.defaultHeaders };
  }
}

/** A per-call `openai` client that reads no OPENAI_* env var (see the class above). */
export function isolatedOpenAI(opts: IsolatedClientOptions): SdkOpenAI {
  return new OpenAI(opts);
}
