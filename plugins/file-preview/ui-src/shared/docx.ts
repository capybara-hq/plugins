/** The `docx` worker's wire types (shared by the app and the worker TypeScript projects). */

export interface DocxInput {
  data: ArrayBuffer;
}

export interface DocxOutput {
  /** mammoth's HTML, images inlined as data URIs; unsanitized, the renderer sanitizes it. */
  html: string;
  /**
   * `invalid`: not a readable .docx; `too-large`: the zip declares more than the limits allow
   * (checked before anything is inflated). The renderer words the reason.
   */
  error?: "invalid" | "too-large";
}
