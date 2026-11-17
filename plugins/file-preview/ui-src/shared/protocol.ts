/**
 * The message protocol between the embed app (`ui-src/app/worker-host.ts`) and a previewer worker
 * (`ui-src/workers/<id>.worker.ts`). Types only: this module is shared by the DOM-typed app and the
 * WebWorker-typed workers.
 *
 * The host posts one request per run; the worker answers it once, with the same `id`.
 */

/** Host -> worker: run the worker's parser on `input`. */
export interface WorkerRequest<I = unknown> {
  id: number;
  input: I;
}

/** Worker -> host: the result of the request with the same `id`. */
export type WorkerResponse<O = unknown> =
  | { id: number; ok: true; output: O }
  | { id: number; ok: false; error: string };
