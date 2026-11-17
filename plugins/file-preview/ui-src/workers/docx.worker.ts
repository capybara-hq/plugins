/**
 * Worker side of the docx previewer: mammoth converts the document to HTML with every image
 * inlined as a `data:` URI (no network, no blob lifetime). The HTML is sanitized by the renderer.
 */
import mammoth from "mammoth";
import type { DocxInput, DocxOutput } from "../shared/docx.js";
import { serve } from "./serve.js";

/**
 * mammoth's browser entry (what the worker bundle gets) reads `arrayBuffer`; its node entry, which
 * unit tests load, reads `buffer`. A real worker has no `Buffer`, so the branch is a test seam.
 */
function source(data: ArrayBuffer): { arrayBuffer: ArrayBuffer } | { buffer: Buffer } {
  return typeof Buffer === "undefined" ? { arrayBuffer: data } : { buffer: Buffer.from(data) };
}

export async function convertDocx(input: DocxInput): Promise<DocxOutput> {
  try {
    const result = await mammoth.convertToHtml(source(input.data), {
      convertImage: mammoth.images.imgElement(async (image) => ({
        src: `data:${image.contentType};base64,${await image.readAsBase64String()}`,
      })),
    });
    return { html: result.value };
  } catch {
    // the renderer words the reason (zh / en) from the code
    return { html: "", error: "invalid" };
  }
}

// the guard keeps the module importable from a test in a plain node process
if (typeof self !== "undefined") {
  serve<DocxInput, DocxOutput>(async (input) => ({ output: await convertDocx(input) }));
}
