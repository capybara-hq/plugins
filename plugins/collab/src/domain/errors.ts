/** Why a domain operation refused. The tool and page layers turn these into actionable text. */
export type CollabErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "version_conflict"
  | "invalid_transition"
  | "gated"
  | "invalid_assignee"
  | "no_longer_assigned";

export class CollabError extends Error {
  readonly code: CollabErrorCode;

  constructor(code: CollabErrorCode, message: string) {
    super(message);
    this.name = "CollabError";
    this.code = code;
  }
}
