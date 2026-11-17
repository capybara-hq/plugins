/**
 * Runs the previewers' parsers in Web Workers under a time budget, so a hostile file can hang a
 * worker but never the page.
 *
 * The embed is a sandboxed iframe with an opaque origin and the CSP `worker-src blob:`: it cannot
 * start a worker from its own URL, and it never `fetch`es plugin assets (WebKit does not match
 * `connect-src 'self'` against the server in an opaque-origin document). The build ships each
 * worker as `assets/<id>.worker.js`, an ES module whose default export is the worker's source
 * text; the host `import()`s it once per id (`script-src 'self'`), and each run starts a worker
 * from a fresh `blob:` URL of that text, revoked as soon as the worker is constructed. A worker is
 * terminated as soon as it answered, failed, ran out of budget or the host was disposed; nothing it
 * sends afterwards reaches the caller.
 */
import type { PreviewerId } from "../../src/previewers.js";
import type { WorkerRequest, WorkerResponse } from "../shared/protocol.js";
import type { RunInWorker } from "./types.js";

/** The budget of one run when the caller sets none. */
export const DEFAULT_WORKER_BUDGET_MS = 20_000;

/** The worker gave no answer within its budget; it has been terminated. */
export class WorkerTimeoutError extends Error {
  override name = "WorkerTimeoutError";
  constructor(worker: string, budgetMs: number) {
    super(`The ${worker} worker gave no answer within ${budgetMs} ms`);
  }
}

/** The host was disposed (file switch or teardown) before the worker answered. */
export class WorkerDisposedError extends Error {
  override name = "WorkerDisposedError";
  constructor() {
    super("The preview was closed before the worker answered");
  }
}

export interface WorkerHostDeps {
  /** Loads a worker module by absolute URL: `(url) => import(url)` in the embed. */
  importModule: (url: string) => Promise<{ default?: unknown }>;
  Worker: typeof Worker;
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** The URL of the built assets, ending in `/` (`…/ui/assets/`). */
  assetBase: string;
}

export interface WorkerHost {
  run: RunInWorker;
  /** Terminates every live worker and rejects pending runs with `WorkerDisposedError`. */
  dispose(): void;
}

/**
 * Starts a worker from its source text (or a Blob of it) through a `blob:` URL, which is revoked as
 * soon as the worker is constructed, also when the constructor throws (a CSP refusal): the worker
 * holds its script once constructed. The pdf renderer uses it for pdf.js's own worker.
 */
export function startWorker(
  source: string | Blob,
  deps: Pick<WorkerHostDeps, "Worker" | "createObjectURL" | "revokeObjectURL">,
): Worker {
  const blob =
    typeof source === "string" ? new Blob([source], { type: "text/javascript" }) : source;
  const url = deps.createObjectURL(blob);
  try {
    return new deps.Worker(url);
  } finally {
    deps.revokeObjectURL(url);
  }
}

function isResponse(data: unknown): data is WorkerResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === "number" && (d.ok === true || (d.ok === false && typeof d.error === "string"))
  );
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export function createWorkerHost(deps: WorkerHostDeps): WorkerHost {
  /**
   * The source text of each worker id, imported once. The host forgets a failed import, and an
   * import still pending when a run's budget ran out, so the next run imports again (the browser
   * may still answer from its module map, which can cache a failure).
   */
  const scripts = new Map<string, Promise<Blob>>();
  /** The cached imports that have settled successfully. */
  const loaded = new WeakSet<Promise<Blob>>();
  /** Every unsettled run: dispose() rejects them all. */
  const pending = new Set<(e: Error) => void>();
  let disposed = false;
  let nextId = 1;

  const script = (worker: string): Promise<Blob> => {
    let blob = scripts.get(worker);
    if (blob === undefined) {
      blob = (async () => {
        const src = `${deps.assetBase}${worker}.worker.js`;
        const mod = await deps.importModule(src);
        if (typeof mod.default !== "string") throw new Error(`${src} has no worker source`);
        return new Blob([mod.default], { type: "text/javascript" });
      })();
      const entry = blob;
      scripts.set(worker, entry);
      entry.then(
        () => loaded.add(entry),
        () => {
          if (scripts.get(worker) === entry) scripts.delete(worker);
        },
      );
    }
    return blob;
  };

  const run = (<I, O>(
    worker: PreviewerId | "pdfjs",
    input: I,
    opts: { budgetMs?: number; transfer?: Transferable[] } = {},
  ): Promise<O> => {
    if (disposed) return Promise.reject(new WorkerDisposedError());
    const budgetMs = opts.budgetMs ?? DEFAULT_WORKER_BUDGET_MS;
    const id = nextId++;

    return new Promise<O>((resolve, reject) => {
      let instance: Worker | undefined;
      let settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(abort);
        if (instance) {
          instance.onmessage = null;
          instance.onerror = null;
          instance.onmessageerror = null;
          instance.terminate();
        }
        outcome();
      };
      const abort = (e: Error) => finish(() => reject(e));
      pending.add(abort);
      const entry = script(worker);
      // the budget covers the script import too; a hung import is not kept for the next run
      const timer = setTimeout(() => {
        if (!loaded.has(entry) && scripts.get(worker) === entry) scripts.delete(worker);
        abort(new WorkerTimeoutError(worker, budgetMs));
      }, budgetMs);

      const start = (blob: Blob) => {
        if (settled) return;
        // `startWorker` can throw (a CSP refusal); the run then fails now, not at the budget
        const w = startWorker(blob, deps);
        instance = w;
        w.onmessage = (e: MessageEvent) => {
          const data: unknown = e.data;
          if (!isResponse(data) || data.id !== id) return;
          if (data.ok) finish(() => resolve(data.output as O));
          else finish(() => reject(new Error(data.error)));
        };
        w.onerror = (e: ErrorEvent) => {
          e.preventDefault?.();
          abort(new Error(e.message || `The ${worker} worker failed`));
        };
        w.onmessageerror = () =>
          abort(new Error(`The ${worker} worker sent an unreadable message`));
        const request: WorkerRequest<I> = { id, input };
        w.postMessage(request, opts.transfer ?? []);
      };
      entry.then(start).catch((e: unknown) => abort(asError(e)));
    });
  }) as RunInWorker;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const abort of [...pending]) abort(new WorkerDisposedError());
    scripts.clear();
  };

  return { run, dispose };
}
