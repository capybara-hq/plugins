import { OBJECT_STORE_CAPABILITY, type ObjectStore } from "@capybara-hq/plugin-sdk";
import {
  assertPluginSecretsReachable,
  pluginDeploymentSecretValues,
  startTestS3,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin, {
  contentDisposition,
  createS3ObjectStore,
  type S3StoreConfig,
} from "../src/index.js";

let s3: TestS3;
let store: ObjectStore;
let config: S3StoreConfig;

beforeAll(async () => {
  s3 = await startTestS3();
  config = {
    endpoint: s3.endpoint,
    region: s3.region,
    bucket: s3.bucket,
    accessKeyId: s3.accessKey,
    secretAccessKey: s3.secretKey,
    forcePathStyle: true,
  };
  store = createS3ObjectStore(config);
}, 180_000);
afterAll(async () => {
  await s3?.stop();
});

/** 字面的 `${`（直接写在字符串里会被 lint 当成误写的模板占位符）。 */
const DB = "\u0024\u007b";
const bytes = (s: string) => new TextEncoder().encode(s);
const text = async (body: ReadableStream<Uint8Array>) => new Response(body).text();
const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(bytes(x));
      c.close();
    },
  });

/** 按 PresignedUpload 上传（POST 表单：先 fields，最后 file）。 */
async function upload(
  u: Awaited<ReturnType<ObjectStore["presignPut"]>>,
  data: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<Response> {
  if (u.method === "PUT") {
    return fetch(u.url, { method: "PUT", headers: u.headers, body: data });
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(u.fields ?? {})) form.append(k, v);
  form.append("file", new Blob([data], { type: contentType }), "upload.bin");
  return fetch(u.url, { method: "POST", headers: u.headers, body: form });
}

describe("contentDisposition", () => {
  it("filename* 按 RFC 5987 编码 '()*，ASCII 兜底替换引号、反斜杠与 %", () => {
    expect(contentDisposition("inline", "a'b (1)*.png")).toBe(
      `inline; filename="a'b (1)*.png"; filename*=UTF-8''a%27b%20%281%29%2A.png`,
    );
    expect(contentDisposition("attachment", 'x"\\%.txt')).toBe(
      `attachment; filename="x___.txt"; filename*=UTF-8''x%22%5C%25.txt`,
    );
    expect(contentDisposition("attachment", undefined)).toBe("attachment");
  });
});

describe("清单", () => {
  it("提供 object-store@1；密钥字段可达、会被打码", () => {
    expect(plugin.provides).toEqual([OBJECT_STORE_CAPABILITY]);
    assertPluginSecretsReachable(plugin);
    expect(pluginDeploymentSecretValues(plugin, config).sort()).toEqual(
      [s3.secretKey, s3.accessKey].sort(),
    );
  });

  it("部署配置：region / bucket 必填；forcePathStyle 默认 false", () => {
    const schema = plugin.config?.deployment;
    expect(schema?.safeParse({ ...config, bucket: undefined }).success).toBe(false);
    const parsed = schema?.parse({
      region: "r",
      bucket: "b",
      accessKeyId: "a",
      secretAccessKey: "s",
    }) as S3StoreConfig;
    expect(parsed.forcePathStyle).toBe(false);
  });
});

describe("S3 ObjectStore（SeaweedFS）", () => {
  it("put / head / get（含范围）/ delete", async () => {
    const h = await store.put("t1/a.txt", bytes("hello world"), { contentType: "text/plain" });
    expect(h).toMatchObject({ key: "t1/a.txt", size: 11, contentType: "text/plain" });
    expect(h.etag).toBeTruthy();

    const head = await store.head("t1/a.txt");
    expect(head).toMatchObject({ key: "t1/a.txt", size: 11, contentType: "text/plain" });
    expect(head?.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const got = await store.get("t1/a.txt");
    expect(got?.head).toMatchObject({ key: "t1/a.txt", size: 11, contentType: "text/plain" });
    expect(await text(got?.body as ReadableStream<Uint8Array>)).toBe("hello world");

    const part = await store.get("t1/a.txt", { range: { start: 6 } });
    expect(await text(part?.body as ReadableStream<Uint8Array>)).toBe("world");
    // 范围读取时 head.size 仍是整个对象的大小
    expect(part?.head.size).toBe(11);
    const mid = await store.get("t1/a.txt", { range: { start: 0, end: 4 } });
    expect(await text(mid?.body as ReadableStream<Uint8Array>)).toBe("hello");

    await store.delete("t1/a.txt");
    expect(await store.head("t1/a.txt")).toBeNull();
    expect(await store.get("t1/a.txt")).toBeNull();
    // 不存在也算成功
    await store.delete("t1/a.txt");
  });

  it("put 流：给出 size 与不给 size 都能写入", async () => {
    const a = await store.put("t2/known", streamOf(["ab", "cd"]), {
      contentType: "application/octet-stream",
      size: 4,
    });
    expect(a.size).toBe(4);
    const b = await store.put("t2/unknown", streamOf(["xy", "z"]), { contentType: "text/plain" });
    expect(b.size).toBe(3);
    const got = await store.get("t2/unknown");
    expect(await text(got?.body as ReadableStream<Uint8Array>)).toBe("xyz");
  });

  it("put 可被 signal 中止", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      store.put("t2/aborted", bytes("x"), { contentType: "text/plain", signal: ac.signal }),
    ).rejects.toThrow();
  });

  it("list 分页；deletePrefix 返回删除数且只删该前缀", async () => {
    for (let i = 0; i < 5; i++) {
      await store.put(`t3/p/${i}`, bytes(`${i}`), { contentType: "text/plain" });
    }
    await store.put("t3/q/keep", bytes("k"), { contentType: "text/plain" });
    const page1 = await store.list("t3/p/", { limit: 2 });
    expect(page1.items.map((i) => i.key)).toEqual(["t3/p/0", "t3/p/1"]);
    expect(page1.items[0]?.size).toBe(1);
    expect(page1.cursor).toBeTruthy();
    const all: string[] = page1.items.map((i) => i.key);
    let cursor = page1.cursor;
    while (cursor) {
      const p = await store.list("t3/p/", { limit: 2, cursor });
      all.push(...p.items.map((i) => i.key));
      cursor = p.cursor;
    }
    expect(all).toEqual(["t3/p/0", "t3/p/1", "t3/p/2", "t3/p/3", "t3/p/4"]);

    expect(await store.deletePrefix("t3/p/")).toBe(5);
    expect((await store.list("t3/p/")).items).toEqual([]);
    expect(await store.head("t3/q/keep")).not.toBeNull();
    expect(await store.deletePrefix("t3/none/")).toBe(0);
  });

  it("deletePrefix 跨多批（超过一页 1000）", async () => {
    const n = 1005;
    for (let i = 0; i < n; i += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, n - i) }, (_, j) =>
          store.put(`t4/${String(i + j).padStart(5, "0")}`, bytes("x"), {
            contentType: "text/plain",
          }),
        ),
      );
    }
    expect(await store.deletePrefix("t4/")).toBe(n);
    expect((await store.list("t4/")).items).toEqual([]);
  }, 60_000);

  it("presignGet：可直接下载；downloadName 进 Content-Disposition", async () => {
    await store.put("t5/doc.txt", bytes("presigned"), { contentType: "text/plain" });
    const url = await store.presignGet("t5/doc.txt", {
      ttlSeconds: 60,
      downloadName: "报告 1.txt",
    });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("presigned");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain("attachment");
    expect(cd).toContain(encodeURIComponent("报告 1.txt"));
  });

  it("presignGet：disposition inline 与 responseContentType 进响应头（RFC 6266 filename*）", async () => {
    await store.put("t5/pic", bytes("png"), { contentType: "application/octet-stream" });
    const inline = await fetch(
      await store.presignGet("t5/pic", {
        ttlSeconds: 60,
        downloadName: "图 1.png",
        disposition: "inline",
        responseContentType: "image/png",
      }),
    );
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("image/png");
    const cd = inline.headers.get("content-disposition") ?? "";
    expect(cd).toMatch(/^inline;/);
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent("图 1.png")}`);

    // 缺省 disposition 为 attachment；没有文件名时也给出 attachment
    const def = await fetch(await store.presignGet("t5/pic", { ttlSeconds: 60 }));
    expect(def.headers.get("content-disposition") ?? "").toMatch(/^attachment/);
  });

  it("presignPut：maxSize 以内可上传；超过 maxSize 被存储拒绝", async () => {
    const u = await store.presignPut("t6/up.bin", {
      contentType: "application/octet-stream",
      maxSize: 10,
      ttlSeconds: 60,
    });
    expect(u.method).toBe("POST");
    const ok = await upload(u, bytes("0123456789"), "application/octet-stream");
    expect(ok.status).toBeLessThan(300);
    expect(await store.head("t6/up.bin")).toMatchObject({
      size: 10,
      contentType: "application/octet-stream",
    });

    const big = await store.presignPut("t6/big.bin", {
      contentType: "application/octet-stream",
      maxSize: 10,
      ttlSeconds: 60,
    });
    const rejected = await upload(big, bytes("0123456789A"), "application/octet-stream");
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(await store.head("t6/big.bin")).toBeNull();
  });

  it("presignPut：只能写到签名的键，类型必须一致", async () => {
    const u = await store.presignPut("t6/fixed.txt", {
      contentType: "text/plain",
      maxSize: 100,
      ttlSeconds: 60,
    });
    const tampered = { ...u, fields: { ...u.fields, key: "t6/other.txt" } };
    expect((await upload(tampered, bytes("x"), "text/plain")).status).toBeGreaterThanOrEqual(400);
    const wrongType = { ...u, fields: { ...u.fields, "Content-Type": "text/html" } };
    expect((await upload(wrongType, bytes("x"), "text/html")).status).toBeGreaterThanOrEqual(400);
    expect(await store.head("t6/other.txt")).toBeNull();
  });

  it("presignPut：策略里显式带 key 条件；改成别的键被存储拒绝", async () => {
    const u = await store.presignPut("t8/a.txt", {
      contentType: "text/plain",
      maxSize: 10,
      ttlSeconds: 60,
    });
    const policy = JSON.parse(Buffer.from(u.fields?.Policy ?? "", "base64").toString("utf8")) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toContainEqual({ key: "t8/a.txt" });
    expect(policy.conditions).toContainEqual(["content-length-range", 0, 10]);
    expect(policy.conditions).toContainEqual(["eq", "$Content-Type", "text/plain"]);
    const other = { ...u, fields: { ...u.fields, key: "t8/b.txt" } };
    expect((await upload(other, bytes("x"), "text/plain")).status).toBeGreaterThanOrEqual(400);
    expect(await store.head("t8/b.txt")).toBeNull();
  });

  it("presignPut：篡改 Policy（放宽大小上限）或 Signature 都被存储拒绝", async () => {
    const u = await store.presignPut("t9/p.txt", {
      contentType: "text/plain",
      maxSize: 4,
      ttlSeconds: 60,
    });
    const fields = u.fields ?? {};
    const policy = JSON.parse(Buffer.from(fields.Policy ?? "", "base64").toString("utf8")) as {
      conditions: unknown[];
    };
    // 把 content-length-range 放宽到 1 MiB、沿用原签名：签名对不上
    const widened = {
      ...policy,
      conditions: policy.conditions.map((c) =>
        Array.isArray(c) && c[0] === "content-length-range" ? [c[0], 0, 1_048_576] : c,
      ),
    };
    const badPolicy = {
      ...u,
      fields: { ...fields, Policy: Buffer.from(JSON.stringify(widened)).toString("base64") },
    };
    expect(
      (await upload(badPolicy, bytes("too long"), "text/plain")).status,
    ).toBeGreaterThanOrEqual(400);
    const sigKey = Object.keys(fields).find((k) => k.toLowerCase() === "x-amz-signature") as string;
    const sig = fields[sigKey] as string;
    const flipped = `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`;
    const badSig = { ...u, fields: { ...fields, [sigKey]: flipped } };
    expect((await upload(badSig, bytes("ok"), "text/plain")).status).toBeGreaterThanOrEqual(400);
    expect(await store.head("t9/p.txt")).toBeNull();
    // 原样的表单可以上传（证明上面的失败来自篡改）
    expect((await upload(u, bytes("ok"), "text/plain")).status).toBeLessThan(300);
  });

  it("presignPut：拒绝含模板变量起始符的键（如 filename 变量，存储端会替换成上传方给的文件名）", async () => {
    for (const key of [`t8/${DB}filename}`, `t8/${DB}x`]) {
      await expect(
        store.presignPut(key, { contentType: "text/plain", maxSize: 1, ttlSeconds: 60 }),
      ).rejects.toThrow(/\$\{/);
    }
  });

  it("预签名的 ttlSeconds 必须是 1..604800 的整数", async () => {
    for (const ttlSeconds of [0, -1, 604_801, 1.5, Number.NaN]) {
      await expect(store.presignGet("t8/a.txt", { ttlSeconds })).rejects.toThrow(RangeError);
      await expect(
        store.presignPut("t8/a.txt", { contentType: "text/plain", maxSize: 1, ttlSeconds }),
      ).rejects.toThrow(RangeError);
    }
    await expect(store.presignGet("t8/a.txt", { ttlSeconds: 604_800 })).resolves.toMatch(/^http/);
  });

  it("publicEndpoint：预签名 URL 用浏览器可达的地址", async () => {
    const pub = createS3ObjectStore({ ...config, publicEndpoint: "https://files.example.com" });
    const get = await pub.presignGet("t7/x", { ttlSeconds: 60 });
    expect(new URL(get).origin).toBe("https://files.example.com");
    const put = await pub.presignPut("t7/x", {
      contentType: "text/plain",
      maxSize: 1,
      ttlSeconds: 60,
    });
    expect(new URL(put.url).origin).toBe("https://files.example.com");
    // 服务端调用仍走 endpoint
    await pub.put("t7/x", bytes("1"), { contentType: "text/plain" });
    expect(await pub.head("t7/x")).not.toBeNull();
  });
});
