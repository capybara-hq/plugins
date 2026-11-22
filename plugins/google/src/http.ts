/** The largest response body the plugin reads from Google (its answers are a few KB). */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads a response body as JSON, stopping (and throwing) once it passes {@link MAX_BODY_BYTES}:
 * a declared `content-length` over the cap is refused unread, and a chunked body is read through
 * the stream only up to the cap.
 */
export async function readJsonCapped(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES || res.body === null) {
    await res.body?.cancel().catch(() => {});
    if (res.body === null) throw new Error("empty response");
    throw new Error("response too large");
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
