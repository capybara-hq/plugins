import {
  type ExtensionContext,
  FILE_PREVIEW_EXTENSION_POINT,
  FILE_PREVIEW_MAX_BYTES,
  type FilePreviewProvider,
  validateFilePreviewProvider,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import extension from "../src/index.js";
import { PREVIEWERS } from "../src/previewers.js";

const ids = PREVIEWERS.map((p) => p.id);

/** Runs `setup` against a fake ctx that records routes and the provider. */
function runSetup() {
  const routes: string[] = [];
  const provided: Array<[string, unknown]> = [];
  const ctx = {
    http: { route: (method: string, path: string) => routes.push(`${method} ${path}`) },
    provide: (ref: string, impl: unknown) => provided.push([ref, impl]),
  } as unknown as ExtensionContext;
  void extension.setup(ctx);
  return { routes, provided };
}

describe("the manifest and setup follow PREVIEWERS", () => {
  it("one file.preview embed per previewer, declared in permissions.ui.embeds", () => {
    expect(extension.ui).toEqual(
      PREVIEWERS.map((p) => ({
        id: p.id,
        title: p.title,
        slot: "file.preview",
        kind: "embed",
        path: `/ui/${p.id}`,
      })),
    );
    expect(extension.permissions?.ui).toEqual({ embeds: ids });
  });

  it("every shell route and the asset route is a declared public GET and registered", () => {
    const declared = [...ids.map((id) => `/ui/${id}`), "/ui/assets/:file"];
    expect(extension.permissions?.http).toEqual(
      declared.map((path) => ({ method: "GET", path, access: "public" })),
    );
    expect(runSetup().routes).toEqual(declared.map((path) => `GET ${path}`));
  });

  it("provides a valid file-preview@1 provider with every previewer at the cap", () => {
    const { provided } = runSetup();
    expect(provided.map(([ref]) => ref)).toEqual([FILE_PREVIEW_EXTENSION_POINT]);
    const provider = provided[0]?.[1] as FilePreviewProvider;
    expect(validateFilePreviewProvider(provider)).toEqual([]);
    expect(provider.previewers.map((p) => [p.id, p.embed, p.maxBytes])).toEqual(
      ids.map((id) => [id, id, FILE_PREVIEW_MAX_BYTES]),
    );
  });
});
