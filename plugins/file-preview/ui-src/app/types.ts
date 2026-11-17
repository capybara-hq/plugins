import type { MessageKey } from "./frame.js";

/** The file the person is previewing, as the outer page sent it over the bridge. */
export interface PreviewFile {
  name: string;
  contentType: string;
  size: number;
  data: ArrayBuffer;
}

/** The workers that answer through `serve()` (pdf.js's worker is started with `startWorker`). */
export type ServedWorkerId = "code" | "zip" | "sheet" | "docx";

/**
 * Runs `input` through the worker of a previewer (a blob-URL worker, terminated on budget or
 * abort) and resolves with its output.
 */
export type RunInWorker = <I, O>(
  worker: ServedWorkerId,
  input: I,
  opts?: { budgetMs?: number; transfer?: Transferable[] },
) => Promise<O>;

/** What the shell hands a renderer. */
export interface RenderContext {
  /** The element the renderer owns; the shell shows it once the renderer resolves. */
  root: HTMLElement;
  locale: "zh" | "en";
  /** The render attempt: aborted when it settles, its budget is spent or the shell is torn down. */
  signal: AbortSignal;
  /**
   * The preview's lifetime: aborted only when the embed tears down or a new file replaces the
   * current one, never when the render settles. Use it for what lives on after the render (pdf
   * pages painted on scroll, a worker kept for the open document).
   */
  lifetime: AbortSignal;
  t(key: MessageKey): string;
  runInWorker: RunInWorker;
  /** An inline error with the reason and the "download instead" hint. */
  showError(reason: string): void;
}

/** One previewer's main-thread side: resolves when the file is painted into `ctx.root`. */
export type Renderer = (file: PreviewFile, ctx: RenderContext) => Promise<void>;
