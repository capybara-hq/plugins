import { defineExtension, FILE_PREVIEW_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { createUiAssets } from "./assets.js";
import { PREVIEWERS, toProvider } from "./previewers.js";

/**
 * File previewers for the conversation's right panel (`file-preview@1`): one embed per previewer,
 * all served by the same static embed app (`ui/`, built by `ui-src/build.ts`). The shell
 * `/ui/<id>` tells the app which renderer to run; the file arrives over the message bridge, so
 * every route here is a public GET that carries no data. No module state, no timers.
 */
export default defineExtension({
  name: "file-preview",
  version: "0.1.0-rc.2",
  sdk: "^0.1.0-rc.27",
  provides: [FILE_PREVIEW_EXTENSION_POINT],
  ui: PREVIEWERS.map((p) => ({
    id: p.id,
    title: p.title,
    slot: "file.preview" as const,
    kind: "embed" as const,
    path: `/ui/${p.id}`,
  })),
  permissions: {
    // Literal paths so the permission check can read them; a test keeps them equal to PREVIEWERS
    http: [
      { method: "GET", path: "/ui/code", access: "public" },
      { method: "GET", path: "/ui/zip", access: "public" },
      { method: "GET", path: "/ui/sheet", access: "public" },
      { method: "GET", path: "/ui/docx", access: "public" },
      { method: "GET", path: "/ui/pdf", access: "public" },
      { method: "GET", path: "/ui/svg", access: "public" },
      { method: "GET", path: "/ui/html", access: "public" },
      { method: "GET", path: "/ui/assets/:file", access: "public" },
    ],
    ui: { embeds: PREVIEWERS.map((p) => p.id) },
  },
  setup(ctx) {
    const assets = createUiAssets();
    ctx.http.route("GET", "/ui/code", () => assets.shell("code"));
    ctx.http.route("GET", "/ui/zip", () => assets.shell("zip"));
    ctx.http.route("GET", "/ui/sheet", () => assets.shell("sheet"));
    ctx.http.route("GET", "/ui/docx", () => assets.shell("docx"));
    ctx.http.route("GET", "/ui/pdf", () => assets.shell("pdf"));
    ctx.http.route("GET", "/ui/svg", () => assets.shell("svg"));
    ctx.http.route("GET", "/ui/html", () => assets.shell("html"));
    ctx.http.route("GET", "/ui/assets/:file", (req) => assets.asset(req));

    ctx.provide(FILE_PREVIEW_EXTENSION_POINT, toProvider());
  },
});
