// The watched input wait contract of @capybara-hq/plugin-sdk (core#939, browser long waits spec
// §5.1), spelled structurally until this repository pins the SDK release that ships it: the
// kernel passes these fields at run time; the SDK version this plugin builds against does not
// type them yet. Each type matches the SDK's own (`InputRequired.watch`, `ToolWatcher`,
// `ToolCallContext.resume.outcome`, `deviceAccess.request` `ifRunning`).
import type {
  FormAnswer,
  InputRequired,
  ToolCallContext,
  ToolHandler,
  ToolSpec,
} from "@capybara-hq/plugin-sdk";

/** How an input round ended (the SDK's `ToolResumeOutcome`). */
export type ResumeOutcome = "answered" | "woken" | "expired";

/** A tool call context whose resume carries the round's outcome. */
export type WatchedCall = Omit<ToolCallContext, "resume"> & {
  resume?: { state: unknown; answer: FormAnswer | null; outcome?: ResumeOutcome };
};

/** A watched `InputRequired`. */
export type WatchedInputRequired = InputRequired & { watch: { deadlineMs: number } };

/** What a watcher gets (the SDK's `ToolWatchContext`). */
export type WatchContext = Omit<ToolCallContext, "resume"> & { state: unknown };

/** A watched wait's watcher (the SDK's `ToolWatcher`). */
export type Watcher = (ctx: WatchContext) => Promise<"settle" | "pending">;

/** `ctx.tools` with the register options. */
export interface WatchTools {
  register(spec: ToolSpec, handler: ToolHandler, opts?: { watch?: Watcher }): void;
}
