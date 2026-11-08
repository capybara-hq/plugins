import { createHash, createHmac } from "node:crypto";

/*
 * Volcengine OpenAPI signature V4 (HMAC-SHA256), node:crypto only. Algorithm per Volcengine's
 * signing docs (https://www.volcengine.com/docs/6369/67269); checked live on 2026-11-08: the
 * signed `ListFoundationModels` / `ListEndpoints` calls of Step 0 were accepted on
 * ark.cn-beijing.volcengineapi.com.
 *
 * - canonical request: method, path, sorted URI-encoded query, the signed headers
 *   (`content-type`, `host`, `x-content-sha256`, `x-date`) as `name:value\n`, their names joined by
 *   `;`, and the hex SHA-256 of the body;
 * - credential scope `<YYYYMMDD>/<region>/<service>/request`;
 * - string to sign `HMAC-SHA256\n<X-Date>\n<scope>\n<hex sha256(canonical request)>`;
 * - key: HMAC chain secret → date → region → service → "request" (no "AWS4" prefix);
 * - `Authorization: HMAC-SHA256 Credential=<AK>/<scope>, SignedHeaders=<names>, Signature=<hex>`.
 */

export interface SignInput {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  now: Date;
}

export interface Signed {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  /** The headers to send (`host` is set by fetch from the URL and left out). */
  headers: Record<string, string>;
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: string | Buffer, s: string) =>
  createHmac("sha256", key).update(s, "utf8").digest();

/** RFC 3986 encoding (encodeURIComponent leaves `!'()*` alone). */
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `20261108T123456Z`. */
export const xDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Signs one request. Pure: the time is an input. */
export function signV4(input: SignInput): Signed {
  const date = xDate(input.now);
  const day = date.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: input.host,
    "x-content-sha256": payloadHash,
    "x-date": date,
  };
  const names = Object.keys(headers).sort();
  const query = Object.keys(input.query)
    .sort()
    .map((k) => `${encode(k)}=${encode(input.query[k] ?? "")}`)
    .join("&");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/request`;
  const stringToSign = ["HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(input.secretAccessKey, day), input.region), input.service),
    "request",
  );
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  const { host: _host, ...sent } = headers;
  return {
    canonicalRequest,
    stringToSign,
    signature,
    headers: {
      ...sent,
      authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
    },
  };
}
