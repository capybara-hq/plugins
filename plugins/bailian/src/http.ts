import type { Target } from "./config.js";
import { type ErrorBody, errorFromBody, errorFromResponse } from "./errors.js";

/** Headers of every request. No retries anywhere: retrying is the kernel's. */
export function headers(t: Target, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${t.apiKey}`, ...extra };
}

/**
 * A JSON request. A non-2xx answer, or a 2xx body that carries an error (`success: false` or a
 * `code` without `output`: the list answers HTTP 200 with `code: "10110400"`), throws ModelError.
 */
export async function requestJson<T>(
  t: Target,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal | undefined },
): Promise<T> {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method: init.method,
    headers: headers(t, init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) throw await errorFromResponse(res);
  const json = (await res.json()) as T & ErrorBody & { success?: boolean; output?: unknown };
  if (json.success === false || (json.code && json.output == null)) {
    throw errorFromBody(undefined, json, res.headers);
  }
  return json;
}
