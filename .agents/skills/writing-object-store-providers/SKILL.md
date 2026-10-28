---
name: writing-object-store-providers
description: 'Use when creating or changing an object store extension (provides object-store@1, e.g. plugins/object-store-s3), or when using ctx.storage in an extension: the semantics of each ObjectStore method (range, list pagination, deletePrefix, null when missing), presigned uploads whose size the store must enforce (POST policy key / content-length-range / Content-Type conditions), rejecting keys containing ${, presignGet disposition and responseContentType, publicEndpoint, what the kernel adds (key prefixes, StorageKeyError, TTL clamping, org cleanup), running under the CLI, and tests with SeaweedFS (startTestS3).'
---

# Writing object store extensions

Object storage holds attachments, artifacts delivered by sandboxes, skill files, plugin packages and extension data. `object-store@1` is a **single-select, brokered** extension point: a deployment installs only one provider, an extension cannot `requires` it and uses it only through `ctx.storage` (the manifest declares `permissions.storage`). For general extension writing see `.agents/skills/writing-extensions`.

Reference implementation: `plugins/object-store-s3` (the official `@aws-sdk/client-s3`; works with the S3-compatible interfaces of AWS S3, MinIO, Ceph, SeaweedFS and OSS / TOS). It is a bootstrap plugin: core pins its version and sha512 and every deployment installs it.

## Contract: `ObjectStore` (SDK `storage.ts`)

| Method | Semantics |
|---|---|
| `put(key, body, { contentType, size?, signal? })` | Overwrites a key of the same name; when `body` is a stream, give `size` if you can; honors `signal` |
| `get(key, { range?, signal? })` | Returns null when missing; `range` is a closed interval, and a missing `end` reads to the end; with a range, `head.size` is still the size of the **whole object** |
| `head(key)` | Returns null when missing; include `etag` where possible (the kernel uses it to check that an attachment was not swapped after finalize) |
| `delete(key)` | A missing key also counts as success |
| `deletePrefix(prefix)` | Deletes every object under the prefix and returns the number deleted; must span multiple pages (S3 allows at most 1000 per batch); must be re-entrant and retryable (the kernel's org cleanup reruns it) |
| `list(prefix, { cursor?, limit? })` | Paginated; a missing `cursor` means there is no next page; when listing carries no type, `contentType` is an empty string |
| `presignGet(key, opts)` | `downloadName` goes into `Content-Disposition` (RFC 6266; non-ASCII uses `filename*=UTF-8''…`); `disposition` defaults to `attachment`; `responseContentType` overrides the response type |
| `presignPut(key, { contentType, maxSize, ttlSeconds })` | Returns `PresignedUpload { method: "PUT" \| "POST", url, headers, fields? }` |

### Presigned upload: the store must reject oversize

- A presigned PUT cannot limit size, so the S3 implementation uses a **POST policy**. Write the conditions in full and do not rely on SDK defaults: `{ key }` (exact key), `["content-length-range", 0, maxSize]`, `["eq", "$Content-Type", contentType]`. The browser puts the `fields` into the form as they are, and puts the file field `file` **last**.
- **Reject keys containing `${`**: in a POST form, a `${filename}` in the key is replaced by the store with the uploader's file name, so the exact-key condition turns into "starts with some prefix" and the uploader can write elsewhere. The extension and the kernel each reject it.
- `ttlSeconds` must be an integer in 1..604800 (the SigV4 limit of 7 days); the kernel clamps before passing it.
- Before declaring support for another store, verify that it **really enforces** POST policies (SeaweedFS has been verified to reject oversize, a changed key and a changed type).
- When the browser-reachable address differs from the address the kernel uses, sign with `publicEndpoint` (the host name takes part in the signature and cannot be replaced afterwards). CORS is configured on the bucket by the deployer; see the plugin README.

### How presignGet opens content

User-uploaded content is opened `inline` only for types that do not execute scripts (images, PDF), and the kernel never asks for inline otherwise; `responseContentType` makes the response carry the type the kernel verified rather than the type recorded in the store.

## What the kernel adds (you do not implement it)

The provider only sees full keys; prefixing and isolation are the kernel's (details in [writing-object-store-providers in core](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-object-store-providers)):

- `ctx.storage` takes a leading `orgId` on every method, and keys land under **`plugins/<plugin name>/<orgId>/`**; kernel data uses `kernel/<orgId>/` and `deployment/`. Keys returned to the caller have the prefix stripped, and listing keeps only objects under that prefix.
- Validation before the provider is called: `orgId` must be a UUID (lower-cased); a relative key must not be empty, start with `/`, or have `.` / `..` segments, `\`, control characters or `${`, and is at most 1024 bytes with the prefix; otherwise `StorageKeyError`.
- With no provider, `ctx.storage` calls reject with `storage.unavailable`, and an extension that declares `permissions.storage` does not load.
- After an org is deleted (default 30 days), a maintenance job runs `deletePrefix` on that org's prefixes; orphan objects are eventually cleared the same way.
- A transient store error makes the kernel retry the step rather than degrade media. So **throw transient failures as they are**: never swallow them and never return null (null means certainly missing).
- Changing the bucket or endpoint without copying objects loses everything already stored (PG records only "in the object store"); deployers copy the `deployment/`, `kernel/` and `plugins/` prefixes first.

## Writing notes

- Stateless: build the client from config; no module-level connection or credential caches (multi-replica discipline). Use `secret()` for key fields.
- Stream uploads / downloads; never read a large object entirely into memory.
- Error messages carry no credentials or signatures.
- **The CLI uses your store without a plugin host**: `capybara plugins import` and `capybara bootstrap` run your `setup` with a context offering only `ctx.config` and `ctx.provide` (any other `ctx` member throws), with the deployment config validated by your schema. Keep `setup` to building the store from `ctx.config` and calling `ctx.provide`, or the CLI refuses with "Object storage is not available to the CLI".

## Testing

- `startTestS3()` from `@capybara-hq/testing`: the official SeaweedFS image (`TEST_S3_IMAGE`, swap it for a private mirror with `CAPYBARA_TEST_S3_IMAGE`); returns `{ endpoint, region, bucket, accessKey, secretKey }`, accessed path-style.
- A provider covers at least: put / head / get (including range) / delete, streaming put (with and without size), abort, list pagination, deletePrefix across several batches, presignGet disposition and file name, presignPut with over `maxSize` / a changed key / a changed type rejected by the **store**, `${` keys rejected, the TTL range, and `publicEndpoint`. See `plugins/object-store-s3/test/s3.test.ts`.
- A plugin that uses `ctx.storage` cannot load `object-store-s3` in its tests (`plugin-test-imports`: a plugin test imports only the SDK, testing, model-fake and itself); load the fake store shipped by `@capybara-hq/testing` (`fakeExtensionDir("fake-object-store")`, configured with what `startTestS3()` returns) next to your plugin.
- Run: `pnpm exec vitest run plugins/object-store-s3` from the repository root.
