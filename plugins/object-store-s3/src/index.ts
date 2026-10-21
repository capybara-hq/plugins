import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  definePlugin,
  OBJECT_STORE_CAPABILITY,
  type ObjectHead,
  type ObjectStore,
  type PresignedUpload,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 部署级配置：一个部署一个桶（键前缀由内核加）。 */
const DeploymentConfig = z.object({
  /** S3 兼容服务的地址（如 MinIO `http://minio:9000`）；不填用 AWS S3 的区域端点。 */
  endpoint: z.string().url().optional(),
  region: z.string().min(1),
  bucket: z.string().min(1),
  accessKeyId: secret(z.string().min(1)),
  secretAccessKey: secret(z.string().min(1)),
  /** 路径风格访问（`<endpoint>/<bucket>/<key>`）；MinIO、Ceph 等一般要开。 */
  forcePathStyle: z.boolean().default(false),
  /**
   * 浏览器可达的地址：预签名 URL 用它签名（主机名参与签名，不能事后替换）。
   * 内核经内网地址 `endpoint` 访问存储、浏览器经公网地址直传时填写；不填用 `endpoint`。
   */
  publicEndpoint: z.string().url().optional(),
});

export type S3StoreConfig = z.input<typeof DeploymentConfig>;

/** S3 单次列举 / 批量删除的上限。 */
const PAGE_MAX = 1000;
/** SigV4 预签名的最长有效期（7 天）。 */
const MAX_TTL_SECONDS = 604_800;
/** 字面的 `${`（POST 策略的变量起始符）。 */
const TEMPLATE_START = "${";

/** 预签名有效期必须是 1..7 天（秒）的整数。 */
const checkTtl = (ttlSeconds: number): number => {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new RangeError(
      `object-store-s3: ttlSeconds must be an integer between 1 and ${MAX_TTL_SECONDS}`,
    );
  }
  return ttlSeconds;
};

const isNotFound = (e: unknown): boolean =>
  e instanceof S3ServiceException &&
  (e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata.httpStatusCode === 404);

/** `Content-Range: bytes 0-4/11` 中的总大小。 */
const totalFromRange = (range: string | undefined): number | undefined => {
  const m = range?.match(/\/(\d+)$/);
  return m ? Number(m[1]) : undefined;
};

/** RFC 6266 / 5987：带非 ASCII 文件名的附件下载头。 */
const contentDisposition = (name: string): string => {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

/** 计数经过的字节（未知大小的流上传后得到对象大小）。 */
const counting = (body: ReadableStream<Uint8Array>, onBytes: (n: number) => void) =>
  body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        onBytes(chunk.byteLength);
        c.enqueue(chunk);
      },
    }),
  );

const toNode = (body: ReadableStream<Uint8Array>): Readable =>
  Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>);

/** 按部署配置构造 S3 兼容的 ObjectStore（插件 setup 与测试共用）。 */
export function createS3ObjectStore(input: S3StoreConfig): ObjectStore {
  const cfg = DeploymentConfig.parse(input);
  const credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  const clientFor = (endpoint: string | undefined) =>
    new S3Client({
      region: cfg.region,
      credentials,
      forcePathStyle: cfg.forcePathStyle,
      ...(endpoint !== undefined && { endpoint }),
      // 只在服务端要求时才算校验和：很多 S3 兼容服务不支持新版默认的 CRC 校验头
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  const client = clientFor(cfg.endpoint);
  // 预签名用浏览器可达的地址签名；只用于本地签名，不发请求
  const signer = cfg.publicEndpoint === undefined ? client : clientFor(cfg.publicEndpoint);
  const Bucket = cfg.bucket;

  const store: ObjectStore = {
    async put(key, body, opts) {
      const ContentType = opts.contentType;
      const abortSignal = opts.signal;
      if (body instanceof Uint8Array) {
        const r = await client.send(
          new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType }),
          sendOpts(abortSignal),
        );
        return { key, size: body.byteLength, contentType: ContentType, ...etag(r.ETag) };
      }
      if (opts.size !== undefined) {
        const r = await client.send(
          new PutObjectCommand({
            Bucket,
            Key: key,
            Body: toNode(body),
            ContentLength: opts.size,
            ContentType,
          }),
          sendOpts(abortSignal),
        );
        return { key, size: opts.size, contentType: ContentType, ...etag(r.ETag) };
      }
      // 大小未知：分段上传（内存占用以分段大小为上限）
      let size = 0;
      const upload = new Upload({
        client,
        params: {
          Bucket,
          Key: key,
          Body: toNode(counting(body, (n) => (size += n))),
          ContentType,
        },
        ...(abortSignal !== undefined && { abortController: abortFrom(abortSignal) }),
      });
      const r = await upload.done();
      return { key, size, contentType: ContentType, ...etag(r.ETag) };
    },

    async get(key, opts) {
      const range = opts?.range;
      try {
        const r = await client.send(
          new GetObjectCommand({
            Bucket,
            Key: key,
            ...(range !== undefined && { Range: `bytes=${range.start}-${range.end ?? ""}` }),
          }),
          sendOpts(opts?.signal),
        );
        const size = totalFromRange(r.ContentRange) ?? r.ContentLength ?? 0;
        const head: ObjectHead = {
          key,
          size,
          contentType: r.ContentType ?? "application/octet-stream",
          ...etag(r.ETag),
          ...modified(r.LastModified),
        };
        const body = r.Body?.transformToWebStream() as ReadableStream<Uint8Array> | undefined;
        return { head, body: body ?? emptyStream() };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          key,
          size: r.ContentLength ?? 0,
          contentType: r.ContentType ?? "application/octet-stream",
          ...etag(r.ETag),
          ...modified(r.LastModified),
        };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    async deletePrefix(prefix) {
      let deleted = 0;
      // 每轮从头列举：删掉的对象不会再出现，不依赖续传标记在删除后是否仍有效
      for (;;) {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: PAGE_MAX }),
        );
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (keys.length === 0) return deleted;
        const r = await client.send(
          new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        const errors = r.Errors ?? [];
        if (errors.length > 0) {
          const first = errors[0];
          throw new Error(
            `object-store-s3: cannot delete ${errors.length} object(s) under prefix: ${first?.Code ?? "error"} ${first?.Message ?? ""}`.trim(),
          );
        }
        deleted += keys.length;
        if (!page.IsTruncated) return deleted;
      }
    },

    async list(prefix, opts) {
      const r = await client.send(
        new ListObjectsV2Command({
          Bucket,
          Prefix: prefix,
          MaxKeys: Math.min(Math.max(1, opts?.limit ?? PAGE_MAX), PAGE_MAX),
          ...(opts?.cursor !== undefined && { ContinuationToken: opts.cursor }),
        }),
      );
      const items: ObjectHead[] = (r.Contents ?? []).flatMap((o) =>
        o.Key === undefined
          ? []
          : [
              {
                key: o.Key,
                size: o.Size ?? 0,
                // 列举不返回类型（需要时用 head）
                contentType: "",
                ...etag(o.ETag),
                ...modified(o.LastModified),
              },
            ],
      );
      return r.IsTruncated && r.NextContinuationToken
        ? { items, cursor: r.NextContinuationToken }
        : { items };
    },

    async presignGet(key, opts) {
      return getSignedUrl(
        signer,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ...(opts.downloadName !== undefined && {
            ResponseContentDisposition: contentDisposition(opts.downloadName),
          }),
        }),
        { expiresIn: checkTtl(opts.ttlSeconds) },
      );
    },

    async presignPut(key, opts): Promise<PresignedUpload> {
      const Expires = checkTtl(opts.ttlSeconds);
      // POST 表单里键中的 ${filename} 会被存储端换成上传方给的文件名：键就不再是签名时的那个
      if (key.includes(TEMPLATE_START)) {
        throw new Error(`object-store-s3: presignPut key must not contain '${TEMPLATE_START}'`);
      }
      // POST 策略：键（显式条件，不依赖 SDK 默认）与类型精确匹配，
      // 大小由存储端按 content-length-range 校验（预签名 PUT 做不到）
      const { url, fields } = await createPresignedPost(signer, {
        Bucket,
        Key: key,
        Conditions: [
          { key },
          ["content-length-range", 0, opts.maxSize],
          ["eq", "$Content-Type", opts.contentType],
        ],
        Fields: { "Content-Type": opts.contentType },
        Expires,
      });
      return { method: "POST", url, headers: {}, fields };
    },
  };
  return store;
}

/** `client.send` 的第二个参数：只在有 signal 时带上。 */
const sendOpts = (signal: AbortSignal | undefined) => (signal ? { abortSignal: signal } : {});
const emptyStream = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
const etag = (v: string | undefined) => (v ? { etag: v.replaceAll('"', "") } : {});
const modified = (d: Date | undefined) => (d ? { lastModified: d.toISOString() } : {});

/** 把调用方的 AbortSignal 接到 lib-storage 要的 AbortController 上。 */
function abortFrom(signal: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal.aborted) ac.abort(signal.reason);
  else signal.addEventListener("abort", () => ac.abort(signal.reason), { once: true });
  return ac;
}

/**
 * 对象存储插件（`object-store@1`）：任何 S3 兼容服务——AWS S3、MinIO、Ceph、SeaweedFS，
 * 以及提供 S3 兼容接口的阿里云 OSS、火山引擎 TOS 等。单选、中转能力：插件经内核的 `ctx.storage` 使用，
 * 键前缀与组织隔离由内核负责。
 */
export default definePlugin({
  name: "object-store-s3",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [OBJECT_STORE_CAPABILITY],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    ctx.provide(OBJECT_STORE_CAPABILITY, createS3ObjectStore(ctx.config as S3StoreConfig));
  },
});
