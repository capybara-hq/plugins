// @vitest-environment jsdom
import { EMBED_PROTOCOL } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../ui-src/app/main.js";
import type { Renderer } from "../ui-src/app/types.js";
import {
  createWorkerHost,
  DEFAULT_WORKER_BUDGET_MS,
  WorkerDisposedError,
  WorkerTimeoutError,
} from "../ui-src/app/worker-host.js";
import type { WorkerRequest, WorkerResponse } from "../ui-src/workers/protocol.js";

/** A stand-in for `Worker`: records what the host posts and lets the test answer. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  posted: Array<{ message: WorkerRequest; transfer: Transferable[] | undefined }> = [];
  terminate = vi.fn();
  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: WorkerRequest, transfer?: Transferable[]) {
    this.posted.push({ message, transfer });
  }
  /** The id of the last request, as a worker would read it. */
  get lastId(): number {
    const last = this.posted.at(-1);
    if (!last) throw new Error("nothing posted");
    return last.message.id;
  }
  answer(data: WorkerResponse | unknown) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  fail(message: string) {
    this.onerror?.(new ErrorEvent("error", { message }));
  }
}

const SCRIPT = "self.onmessage = () => {};";
const BASE = "https://host.test/plugin-ui/file-preview/ui/assets/";

type ImportModule = (url: string) => Promise<{ default?: unknown }>;

function setup(importImpl?: ImportModule) {
  const importModule = vi.fn<ImportModule>(importImpl ?? (async () => ({ default: SCRIPT })));
  const blobs: Blob[] = [];
  const createObjectURL = vi.fn((b: Blob) => {
    blobs.push(b);
    return `blob:null/${blobs.length}`;
  });
  const revokeObjectURL = vi.fn();
  const host = createWorkerHost({
    importModule,
    Worker: FakeWorker as unknown as typeof Worker,
    createObjectURL,
    revokeObjectURL,
    assetBase: BASE,
  });
  return { host, importModule, blobs, createObjectURL, revokeObjectURL };
}

/** An import that settles in microtasks only, for fake-timer tests. */
const quickImport: ImportModule = async () => ({ default: SCRIPT });

/**
 * The worker the host started, without advancing time: `vi.waitFor` advances fake timers, which
 * would spend the budget under test.
 */
async function startedNow(): Promise<FakeWorker> {
  await settle();
  const w = FakeWorker.instances[0];
  if (!w) throw new Error("no worker started");
  return w;
}

/** Lets the host's import → blob → `new Worker` chain settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Waits until the host has started `n` workers in total. */
async function started(n: number): Promise<FakeWorker> {
  await vi.waitFor(() => expect(FakeWorker.instances.length).toBeGreaterThanOrEqual(n));
  const w = FakeWorker.instances[n - 1];
  if (!w) throw new Error("no worker");
  return w;
}

beforeEach(() => {
  FakeWorker.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createWorkerHost", () => {
  it("imports assets/<id>.worker.js, starts a blob worker from its source and resolves the output", async () => {
    const { host, importModule, blobs, revokeObjectURL } = setup();
    const result = host.run<{ text: string }, string>("code", { text: "x" });
    const w = await started(1);
    expect(importModule).toHaveBeenCalledWith(`${BASE}code.worker.js`);
    expect(w.url).toBe("blob:null/1");
    // the blob URL is revoked as soon as the worker is constructed
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:null/1");
    expect(await blobs[0]?.text()).toBe(SCRIPT);
    expect(blobs[0]?.type).toBe("text/javascript");
    expect(w.posted.map((p) => p.message.input)).toEqual([{ text: "x" }]);
    w.answer({ id: w.lastId, ok: true, output: "<done>" });
    await expect(result).resolves.toBe("<done>");
    // one worker per run: it is terminated once it answered
    expect(w.terminate).toHaveBeenCalled();
    host.dispose();
  });

  it("passes the transfer list to postMessage", async () => {
    const { host } = setup();
    const buf = new ArrayBuffer(8);
    const result = host.run("zip", buf, { transfer: [buf] });
    const w = await started(1);
    expect(w.posted[0]?.transfer).toEqual([buf]);
    w.answer({ id: w.lastId, ok: true, output: 1 });
    await result;
    host.dispose();
  });

  it("rejects with the worker's message on ok:false", async () => {
    const { host } = setup();
    const result = host.run("sheet", 1);
    const w = await started(1);
    w.answer({ id: w.lastId, ok: false, error: "not a spreadsheet" });
    await expect(result).rejects.toThrow(new Error("not a spreadsheet"));
    expect(w.terminate).toHaveBeenCalled();
    host.dispose();
  });

  it("ignores answers with another id and malformed messages", async () => {
    const { host } = setup();
    const result = host.run("code", 1);
    const w = await started(1);
    const outcome = vi.fn();
    result.then(outcome, outcome);
    w.answer({ id: w.lastId + 1, ok: true, output: "wrong" });
    w.answer("garbage");
    w.answer(null);
    await settle();
    expect(outcome).not.toHaveBeenCalled();
    w.answer({ id: w.lastId, ok: true, output: "right" });
    await expect(result).resolves.toBe("right");
    host.dispose();
  });

  it("rejects when the worker script throws (error event)", async () => {
    const { host } = setup();
    const result = host.run("docx", 1);
    const w = await started(1);
    w.fail("SyntaxError: boom");
    await expect(result).rejects.toThrow("SyntaxError: boom");
    expect(w.terminate).toHaveBeenCalled();
    host.dispose();
  });

  it("rejects at once when the Worker constructor throws (e.g. a CSP SecurityError)", async () => {
    class Throwing {
      constructor() {
        throw new DOMException("refused by worker-src", "SecurityError");
      }
    }
    const revokeObjectURL = vi.fn();
    const host = createWorkerHost({
      importModule: async () => ({ default: SCRIPT }),
      Worker: Throwing as unknown as typeof Worker,
      createObjectURL: () => "blob:null/x",
      revokeObjectURL,
      assetBase: BASE,
    });
    await expect(host.run("code", 1)).rejects.toThrow("refused by worker-src");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:null/x");
    host.dispose();
  });

  it("no answer within budgetMs: WorkerTimeoutError and the worker is terminated", async () => {
    vi.useFakeTimers();
    const { host } = setup(quickImport);
    const result = host.run("pdf", 1, { budgetMs: 10_000 });
    const caught = result.catch((e: unknown) => e);
    const w = await startedNow();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(w.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const err = await caught;
    expect(err).toBeInstanceOf(WorkerTimeoutError);
    expect(w.terminate).toHaveBeenCalled();
    // a late answer changes nothing
    w.answer({ id: w.lastId, ok: true, output: "late" });
    host.dispose();
  });

  it("defaults to a 20 000 ms budget", async () => {
    expect(DEFAULT_WORKER_BUDGET_MS).toBe(20_000);
    vi.useFakeTimers();
    const { host } = setup(quickImport);
    const caught = host.run("code", 1).catch((e: unknown) => e);
    const w = await startedNow();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(w.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await caught).toBeInstanceOf(WorkerTimeoutError);
    expect(w.terminate).toHaveBeenCalled();
    host.dispose();
  });

  it("the budget covers a hanging script import: no worker is started after it", async () => {
    vi.useFakeTimers();
    let release: (m: { default: unknown }) => void = () => {};
    const { host } = setup(() => new Promise((r) => (release = r)));
    const caught = host.run("code", 1, { budgetMs: 100 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await caught).toBeInstanceOf(WorkerTimeoutError);
    release({ default: SCRIPT });
    await settle();
    expect(FakeWorker.instances).toEqual([]);
    host.dispose();
  });

  it("imports the script once per worker id", async () => {
    const { host, importModule, revokeObjectURL } = setup();
    const a = host.run("code", 1);
    const b = host.run("code", 2);
    const w1 = await started(1);
    const w2 = await started(2);
    w1.answer({ id: w1.lastId, ok: true, output: "a" });
    w2.answer({ id: w2.lastId, ok: true, output: "b" });
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    const c = host.run("code", 3);
    const w3 = await started(3);
    w3.answer({ id: w3.lastId, ok: true, output: "c" });
    await c;
    expect(importModule).toHaveBeenCalledTimes(1);
    // one blob URL per worker, each revoked once its worker started
    expect(revokeObjectURL.mock.calls.map((c) => c[0])).toEqual([w1.url, w2.url, w3.url]);
    const d = host.run("pdfjs", 4);
    const w4 = await started(4);
    w4.answer({ id: w4.lastId, ok: true, output: "d" });
    await d;
    expect(importModule).toHaveBeenCalledTimes(2);
    expect(importModule).toHaveBeenLastCalledWith(`${BASE}pdfjs.worker.js`);
    host.dispose();
  });

  it("a failed script import rejects the run and is retried by the next one", async () => {
    let fail = true;
    const { host, importModule } = setup(async (url) => {
      if (fail) throw new TypeError(`error loading dynamically imported module: ${url}`);
      return { default: SCRIPT };
    });
    await expect(host.run("svg", 1)).rejects.toThrow(/svg\.worker\.js/);
    fail = false;
    const result = host.run("svg", 1);
    const w = await started(1);
    w.answer({ id: w.lastId, ok: true, output: "ok" });
    await expect(result).resolves.toBe("ok");
    expect(importModule).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it("a module without a string default export rejects the run", async () => {
    const { host } = setup(async () => ({ default: 42 }));
    await expect(host.run("html", 1)).rejects.toThrow(/html\.worker\.js.*no worker source/);
    expect(FakeWorker.instances).toEqual([]);
    host.dispose();
  });

  it("dispose() terminates live workers and rejects pending runs", async () => {
    const { host } = setup();
    const a = host.run("code", 1).catch((e: unknown) => e);
    const b = host.run("zip", 2).catch((e: unknown) => e);
    const wa = await started(1);
    const wb = await started(2);
    host.dispose();
    expect(await a).toBeInstanceOf(WorkerDisposedError);
    expect(await b).toBeInstanceOf(WorkerDisposedError);
    expect(wa.terminate).toHaveBeenCalled();
    expect(wb.terminate).toHaveBeenCalled();
    await expect(host.run("code", 3)).rejects.toBeInstanceOf(WorkerDisposedError);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it("dispose() while the script is being imported starts no worker", async () => {
    let release: (m: { default: unknown }) => void = () => {};
    const { host } = setup(() => new Promise((r) => (release = r)));
    const caught = host.run("code", 1).catch((e: unknown) => e);
    await settle();
    host.dispose();
    expect(await caught).toBeInstanceOf(WorkerDisposedError);
    release({ default: SCRIPT });
    await settle();
    expect(FakeWorker.instances).toEqual([]);
  });

  // Review Focus 3: the old file's result never paints over the new one
  it("a result that arrives after dispose() never reaches the renderer's DOM write", async () => {
    const { host } = setup();
    const paint = vi.fn();
    const renderer = async () => {
      const html = await host.run<number, string>("code", 1);
      paint(html);
    };
    const rendering = renderer().catch((e: unknown) => e);
    const w = await started(1);
    host.dispose();
    w.answer({ id: w.lastId, ok: true, output: "<old file>" });
    expect(await rendering).toBeInstanceOf(WorkerDisposedError);
    await settle();
    expect(paint).not.toHaveBeenCalled();
    expect(w.terminate).toHaveBeenCalled();
  });
});

describe("startApp wiring", () => {
  const init = { protocol: EMBED_PROTOCOL, type: "init", locale: "en", theme: "light", tokens: {} };
  const file = {
    protocol: EMBED_PROTOCOL,
    type: "file",
    name: "a.ts",
    contentType: "text/plain",
    size: 3,
    data: new ArrayBuffer(3),
  };
  const post = (data: unknown) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: window.parent }));

  let restore: Array<() => void> = [];
  beforeEach(() => {
    document.head.innerHTML = '<meta name="previewer" content="code">';
    document.body.innerHTML = '<div id="root"></div>';
    const w = window as unknown as Record<string, unknown>;
    const saved = {
      Worker: w.Worker,
      fetch: w.fetch,
      create: URL.createObjectURL,
      revoke: URL.revokeObjectURL,
    };
    w.Worker = FakeWorker;
    // nothing in the embed fetches plugin assets
    w.fetch = vi.fn(async () => {
      throw new Error("fetch must not be used");
    });
    URL.createObjectURL = vi.fn(() => "blob:null/app");
    URL.revokeObjectURL = vi.fn();
    restore.push(() => {
      w.Worker = saved.Worker;
      w.fetch = saved.fetch;
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    });
  });
  afterEach(() => {
    for (const r of restore) r();
    restore = [];
  });

  it("hands renderers the real worker host, importing from assets/ beside the shell", async () => {
    const outputs: unknown[] = [];
    const renderer: Renderer = async (_f, ctx) => {
      outputs.push(await ctx.runInWorker("code", "src"));
    };
    const importModule = vi.fn(async (_url: string) => ({ default: SCRIPT }));
    const stop = startApp({ loadRenderer: async () => renderer, importModule });
    try {
      post(init);
      post(file);
      const w = await started(1);
      const expected = new URL("assets/code.worker.js", document.baseURI).href;
      expect(importModule).toHaveBeenCalledWith(expected);
      expect(window.fetch).not.toHaveBeenCalled();
      expect(w.url).toBe("blob:null/app");
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:null/app");
      w.answer({ id: w.lastId, ok: true, output: "painted" });
      await vi.waitFor(() => expect(outputs).toEqual(["painted"]));
    } finally {
      stop();
    }
  });

  it("tearing the app down terminates the running worker and drops its late result", async () => {
    const paint = vi.fn();
    const renderer: Renderer = async (_f, ctx) => {
      paint(await ctx.runInWorker("code", "src"));
    };
    const stop = startApp({
      loadRenderer: async () => renderer,
      importModule: async () => ({ default: SCRIPT }),
    });
    post(init);
    post(file);
    const w = await started(1);
    stop();
    expect(w.terminate).toHaveBeenCalled();
    w.answer({ id: w.lastId, ok: true, output: "late" });
    await settle();
    expect(paint).not.toHaveBeenCalled();
  });
});
