import type { PreviewerId } from "../../src/previewers.js";
import type { Renderer } from "../app/types.js";

/**
 * The renderer of a previewer, one dynamic import per id so every previewer is its own chunk and
 * the shell loads only what the file needs.
 */
export async function loadRenderer(id: PreviewerId): Promise<Renderer> {
  switch (id) {
    case "code":
    case "zip":
    case "sheet":
    case "docx":
    case "pdf":
    case "svg":
    case "html":
      return (await import("./pending.js")).default;
  }
}
