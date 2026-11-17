/** The `docx` worker's wire types (shared by the app and the worker TypeScript projects). */

export interface DocxInput {
  data: ArrayBuffer;
}

export interface DocxOutput {
  /** mammoth's HTML, images inlined as data URIs; unsanitized, the renderer sanitizes it. */
  html: string;
  /** `invalid`: the file is not a readable .docx (the renderer words the reason). */
  error?: "invalid";
}
