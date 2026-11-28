/** Why a domain operation refused. The tool and page layers turn these into actionable text. */
export type CollabErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "version_conflict"
  | "invalid_transition"
  | "gated"
  | "invalid_assignee"
  | "no_longer_assigned"
  | "archived"
  | "watcher_limit";

/** What a person reads when a write hits an archived project. */
// capybara:allow-module-state read-only constant
export const ARCHIVED_TOAST: Readonly<{ zh: string; en: string }> = {
  zh: "项目已归档，只能查看。项目所有者可以在项目设置中取消归档。",
  en: "The project is archived and read-only. A project owner can unarchive it in the project settings.",
};

export class CollabError extends Error {
  readonly code: CollabErrorCode;

  constructor(code: CollabErrorCode, message: string) {
    super(message);
    this.name = "CollabError";
    this.code = code;
  }
}
