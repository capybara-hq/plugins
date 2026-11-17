/**
 * pdf.js's own worker (the legacy build, for the browsers the platform supports). It is not a
 * `serve()` worker: the pdf renderer starts it from a `blob:` URL of this bundle and hands it to
 * pdf.js as its port; pdf.js's worker module wires itself to `self` when it loads. The build
 * bundles its JPEG 2000 / JBIG2 JS decoders in (no WebAssembly, no runtime import).
 */
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
