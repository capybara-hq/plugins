/** `v` trimmed when it is a non-empty string. */
export function text(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** `v` when it is a string that parses as an http(s) URL. */
export function httpUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const t = v.trim();
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? t : undefined;
  } catch {
    return undefined;
  }
}
