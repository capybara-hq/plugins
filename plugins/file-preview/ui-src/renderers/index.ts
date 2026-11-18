import type { PreviewerId } from "../../src/previewers.js";
import type { Renderer } from "../app/types.js";

/**
 * The renderer of a previewer: one static dynamic import per id, so each previewer is its own
 * chunk and a renderer task edits only its own `<id>.ts`.
 */
export async function loadRenderer(id: PreviewerId): Promise<Renderer> {
  switch (id) {
    case "code":
      return (await import("./code.js")).render;
    case "zip":
      return (await import("./zip.js")).render;
    case "sheet":
      return (await import("./sheet.js")).render;
    case "docx":
      return (await import("./docx.js")).render;
    case "pdf":
      return (await import("./pdf.js")).render;
    case "svg":
      return (await import("./svg.js")).render;
  }
}
