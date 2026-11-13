import type { ExtensionContext } from "@capybara-hq/plugin-sdk";

/**
 * Stand-ins for `ctx.models` and `ctx.queue` in unit tests. model-fake's vectors are hashes of the
 * text (no two different texts are close), so tests that need "close in meaning" use these vectors:
 * one dimension per topic plus a small constant, padded with zeros to `dims`.
 */

// capybara:allow-module-state read-only test topics
const TOPICS = [
  ["coffee", "espresso", "latte", "caffeine"],
  ["puppy", "dog"],
  ["launch", "deadline"],
  ["typescript"],
];

export function topicVector(text: string, dims = 5): number[] {
  const t = text.toLowerCase();
  const v: number[] = TOPICS.map((words) => (words.some((w) => t.includes(w)) ? 1 : 0));
  v.push(0.1);
  while (v.length < dims) v.push(0);
  return v.slice(0, dims);
}

export function fakeModels(
  opts: { mapped?: boolean; model?: string; dims?: number; fail?: boolean; hang?: boolean } = {},
): ExtensionContext["models"] {
  const { mapped = true, model = "emb-1", dims = 5, fail = false, hang = false } = opts;
  return {
    async describe() {
      return mapped
        ? {
            provider: "fake",
            id: model,
            kind: "embedding",
            embedding: {
              dimensions: [dims],
              defaultDimensions: dims,
              maxInputTokens: 512,
              maxBatch: 4,
            },
          }
        : null;
    },
    async embed(req) {
      if (!mapped) {
        throw Object.assign(new Error("No embedding model is mapped"), {
          code: "model.unconfigured",
        });
      }
      if (fail) throw new Error("provider down");
      if (hang) await new Promise(() => {});
      return {
        vectors: req.input.map((t) => topicVector(t, dims)),
        model: { provider: "fake", id: model },
        dimensions: dims,
      };
    },
  } as ExtensionContext["models"];
}

export interface QueuedJob {
  name: string;
  data: unknown;
  opts: unknown;
}

/**
 * A stand-in for `ctx.queue` that dedupes like the kernel's: a job id already added (pending,
 * completed or failed and still retained) is not added again. The kernel keeps completed and
 * failed jobs for a while (`removeOnComplete` / `removeOnFail`), so a reused id is a dropped job.
 */
export function fakeQueue(jobs: QueuedJob[]): ExtensionContext["queue"] {
  const retained = new Set<string>();
  return {
    define() {},
    async add(name, data, opts) {
      const id = (opts as { jobId?: string } | undefined)?.jobId;
      if (id !== undefined) {
        if (retained.has(id)) return;
        retained.add(id);
      }
      jobs.push({ name, data, opts });
    },
  };
}
