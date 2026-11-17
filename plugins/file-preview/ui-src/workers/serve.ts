/**
 * The worker side of the protocol: `serve(handler)` answers every request with the handler's
 * output, or with its error message. A worker script is `serve(parse)` and nothing else.
 */
import type { WorkerRequest, WorkerResponse } from "../shared/protocol.js";

/** What a handler returns: the output, and the buffers to transfer with it. */
export interface Served<O> {
  output: O;
  transfer?: Transferable[];
}

/** The part of the worker global `serve` uses (a parameter so tests can pass a fake). */
export interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message !== "" ? e.message : "The worker failed";
  const s = String(e);
  return s === "" ? "The worker failed" : s;
}

export function serve<I, O>(
  handler: (input: I) => Served<O> | Promise<Served<O>>,
  scope: WorkerScope = self as unknown as WorkerScope,
): void {
  scope.onmessage = (e: MessageEvent) => {
    const { id, input } = e.data as WorkerRequest<I>;
    void (async () => {
      try {
        const { output, transfer = [] } = await handler(input);
        const answer: WorkerResponse<O> = { id, ok: true, output };
        scope.postMessage(answer, transfer);
      } catch (err) {
        const answer: WorkerResponse<O> = { id, ok: false, error: errorText(err) };
        scope.postMessage(answer, []);
      }
    })();
  };
}
