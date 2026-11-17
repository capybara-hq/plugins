/**
 * Worker side of the docx previewer: mammoth converts the document to HTML with every image
 * inlined as a `data:` URI (no network, no blob lifetime). The HTML is sanitized by the renderer.
 */
import mammoth from "mammoth";
import type { DocxInput, DocxOutput } from "../shared/docx.js";
import { serve } from "./serve.js";
import { listEntries } from "./zip.logic.js";

/** A docx is a zip: its declared sizes are checked before mammoth (JSZip) inflates anything. */
export const ENTRY_MAX = 50 * 1024 * 1024;
export const TOTAL_MAX = 100 * 1024 * 1024;

/**
 * mammoth's browser entry (what the worker bundle gets) reads `arrayBuffer`; its node entry, which
 * unit tests load, reads `buffer`. A real worker has no `Buffer`, so the branch is a test seam.
 */
function source(data: ArrayBuffer): { arrayBuffer: ArrayBuffer } | { buffer: Buffer } {
  return typeof Buffer === "undefined" ? { arrayBuffer: data } : { buffer: Buffer.from(data) };
}

export async function convertDocx(input: DocxInput): Promise<DocxOutput> {
  // the directory is read with the zip previewer's capped reader (it never inflates)
  const dir = listEntries({ data: input.data });
  if (dir.error !== undefined) return { html: "", error: "invalid" };
  let total = 0;
  for (const e of dir.entries) {
    total += e.size;
    if (e.size > ENTRY_MAX || total > TOTAL_MAX) return { html: "", error: "too-large" };
  }
  // more entries than the reader lists: the declared total cannot be known
  if (dir.truncated) return { html: "", error: "too-large" };
  try {
    const result = await mammoth.convertToHtml(source(input.data), {
      convertImage: mammoth.images.imgElement(async (image) => ({
        src: `data:${image.contentType};base64,${await image.readAsBase64String()}`,
      })),
    });
    return { html: result.value };
  } catch (e) {
    // a parse failure is "invalid"; resource and programming errors surface with their message
    if (e instanceof RangeError || e instanceof TypeError || e instanceof ReferenceError) throw e;
    if (!(e instanceof Error)) throw e;
    return { html: "", error: "invalid" };
  }
}

// the guard keeps the module importable from a test in a plain node process
if (typeof self !== "undefined") {
  serve<DocxInput, DocxOutput>(async (input) => ({ output: await convertDocx(input) }));
}
