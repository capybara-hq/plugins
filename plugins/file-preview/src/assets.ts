/**
 * Serves the built embed app (`ui/`, written by `ui-src/build.ts`) on public routes.
 *
 * Only names listed in `ui/manifest.json` are served, and a name must be flat
 * (`[A-Za-z0-9][A-Za-z0-9.-]*`), so no request reaches a file outside that allowlist: no `..`, no
 * encoded separators, no subdirectories, not the manifest itself. The pages carry no data.
 */
import { readFile, stat } from "node:fs/promises";

/** `ui/manifest.json` as `buildUi` writes it. */
interface UiManifest {
  files: Record<string, { contentType: string; sha256: string }>;
}

/** The serving side of the embed app; create one per `setup` (it caches the manifest by mtime). */
export interface UiAssets {
  /** The shell page for one previewer: `index.html` with `<meta name="previewer" content="<id>">`. */
  shell(previewer: string): Promise<Response>;
  /** `GET …/ui/assets/<name>`: a manifest-listed file, else 404. */
  asset(req: Request): Promise<Response>;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const PREVIEWER_RE = /^[a-z0-9-]{1,40}$/;
const ASSET_PATH_RE = /\/ui\/assets\/([^/]*)$/;
/** esbuild's split chunks (`chunk-[hash].js`): the name changes with the content. */
const CHUNK_RE = /^chunk-[a-z0-9]+\.js$/i;
/** Defense in depth if the kernel's /plugins is ever exposed without the web proxy. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox allow-scripts allow-forms; frame-ancestors 'self'",
} as const;
const IMMUTABLE = "private, max-age=31536000, immutable";

/** The cache policy of a served file: hashed chunks forever, everything else revalidated. */
export function cacheControl(name: string): string {
  return CHUNK_RE.test(name) ? IMMUTABLE : "no-cache";
}

const notFound = () =>
  Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });

/**
 * `dir` is the `ui/` directory as a URL ending in `/`; the default is the same relative path from
 * `src/` (tests, source loading) and from the packed `dist/`.
 */
export function createUiAssets(dir: URL = new URL("../ui/", import.meta.url)): UiAssets {
  // Per extension instance, not module state: re-read when the file's mtime changes (a rebuild in
  // dev), so a long-running kernel serves the new build.
  let cached: { mtimeMs: number; manifest: UiManifest } | undefined;
  const loadManifest = async (): Promise<UiManifest> => {
    const url = new URL("manifest.json", dir);
    const { mtimeMs } = await stat(url);
    if (cached?.mtimeMs === mtimeMs) return cached.manifest;
    const manifest = JSON.parse(await readFile(url, "utf8")) as UiManifest;
    cached = { mtimeMs, manifest };
    return manifest;
  };

  /** The manifest entry for a flat name, or undefined (unlisted, malformed or no build). */
  const entry = async (name: string) => {
    if (!NAME_RE.test(name)) return undefined;
    let m: UiManifest;
    try {
      m = await loadManifest();
    } catch {
      return undefined;
    }
    return Object.hasOwn(m.files, name) ? m.files[name] : undefined;
  };

  const read = async (name: string): Promise<Uint8Array | undefined> => {
    try {
      return await readFile(new URL(name, dir));
    } catch {
      return undefined;
    }
  };

  return {
    async shell(previewer) {
      if (!PREVIEWER_RE.test(previewer)) return notFound();
      const file = await entry("index.html");
      const bytes = file && (await read("index.html"));
      if (!file || !bytes) return notFound();
      const meta = `<meta name="previewer" content="${previewer}">`;
      const html = new TextDecoder().decode(bytes).replace(/<head>/i, (h) => `${h}\n    ${meta}`);
      return new Response(html, {
        headers: {
          "content-type": file.contentType,
          "cache-control": cacheControl("index.html"),
          ...SECURITY_HEADERS,
        },
      });
    },

    async asset(req) {
      const name = ASSET_PATH_RE.exec(new URL(req.url).pathname)?.[1] ?? "";
      // the shell is served only at /ui/<id>, never as an asset
      const file = name === "index.html" ? undefined : await entry(name);
      const bytes = file && (await read(name));
      if (!file || !bytes) return notFound();
      return new Response(bytes, {
        headers: {
          "content-type": file.contentType,
          "cache-control": cacheControl(name),
          ...SECURITY_HEADERS,
        },
      });
    },
  };
}
