import { WebProviderError, type WebProviderErrorKind } from "@capybara-hq/plugin-sdk";

export type JinaOp = "search" | "reader";

/** Maps an HTTP status of a failed Jina call to a provider error kind. */
export function jinaErrorKind(op: JinaOp, status: number): WebProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status === 422) return op === "reader" ? "not_found" : "invalid";
  if (status === 451) return "blocked";
  if (status >= 500) return "unavailable";
  return "invalid";
}

/** `base` without a trailing `/` plus `path` (which starts with `/`). */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

/**
 * Calls Jina and returns the parsed JSON body of a 2xx answer. Errors carry the status only: never
 * the key, the URL or the response body.
 */
export async function jinaRequest(
  op: JinaOp,
  url: string,
  init: {
    apiKey: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
): Promise<unknown> {
  const name = `Jina ${op}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${init.apiKey}`,
        Accept: "application/json",
      },
      ...(init.body !== undefined && { body: init.body }),
      signal: init.signal,
    });
  } catch (err) {
    if (init.signal.aborted) throw err;
    throw new WebProviderError(`${name} failed: network error`, { kind: "unavailable" });
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new WebProviderError(`${name} failed: HTTP ${res.status}`, {
      kind: jinaErrorKind(op, res.status),
    });
  }
  try {
    return await res.json();
  } catch (err) {
    if (init.signal.aborted) throw err;
    throw new WebProviderError(`${name} returned an unexpected response`, {
      kind: "unavailable",
    });
  }
}
