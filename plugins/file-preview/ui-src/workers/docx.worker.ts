/**
 * Worker side of the docx previewer: mammoth converts the document to HTML with every image
 * inlined as a `data:` URI (no network, no blob lifetime). The HTML is sanitized by the renderer.
 */
import mammoth from "mammoth";
import type { DocxInput, DocxOutput } from "../shared/docx.js";
import { serve } from "./serve.js";
import { MAX_ENTRIES, verifyArchive } from "./zip.logic.js";

/** A docx is a zip: `verifyArchive` proves it within these before mammoth (JSZip) touches it. */
export const ENTRY_MAX = 50 * 1024 * 1024;
export const TOTAL_MAX = 100 * 1024 * 1024;

type MammothInput = Parameters<typeof mammoth.convertToHtml>[0];

/**
 * mammoth's browser entry (what the worker bundle gets) reads `arrayBuffer`; its node entry, which
 * unit tests load, reads `buffer`. A real worker has no `Buffer`, so the branch is a test seam (a
 * typed global lookup: the workers compile without node types).
 */
function source(data: ArrayBuffer): MammothInput {
  const NodeBuffer = (globalThis as { Buffer?: { from(d: ArrayBuffer): Uint8Array } }).Buffer;
  return NodeBuffer === undefined
    ? { arrayBuffer: data }
    : ({ buffer: NodeBuffer.from(data) } as unknown as MammothInput);
}

export async function convertDocx(input: DocxInput): Promise<DocxOutput> {
  // JSZip inflates a whole entry before it checks the declared size, and reads non-canonical
  // archives differently from a plain directory reader: prove the archive first (ruling R21)
  const verdict = verifyArchive(new Uint8Array(input.data), {
    entryMax: ENTRY_MAX,
    totalMax: TOTAL_MAX,
    maxEntries: MAX_ENTRIES,
  });
  if (!verdict.ok) return { html: "", error: verdict.reason };
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
