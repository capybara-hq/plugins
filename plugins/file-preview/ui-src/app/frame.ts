/** The loading / empty / error states and the shell's strings (zh and en). */
import { WorkerTimeoutError } from "./worker-host.js";

export const MESSAGES = {
  zh: {
    loading: "正在加载…",
    empty: "空文件",
    errorTitle: "无法预览此文件",
    downloadHint: "可以用右上角的下载查看原文件",
    timeout: "解析超时",
    readerFailed: "读取文件失败",
  },
  en: {
    loading: "Loading…",
    empty: "Empty file",
    errorTitle: "Can't preview this file",
    downloadHint: "Use Download at the top right to open the original",
    timeout: "Took too long to read",
    readerFailed: "The file reader failed",
  },
} as const satisfies Record<"zh" | "en", Record<string, string>>;

export type MessageKey = keyof (typeof MESSAGES)["en"];

export type Translate = (key: MessageKey) => string;

export function translator(locale: "zh" | "en"): Translate {
  const table: Record<MessageKey, string> = MESSAGES[locale];
  return (key) => table[key];
}

/**
 * The reason shown when a parse (a worker run, or the shell's whole-file budget) failed: a timeout
 * is the shell's timeout message; anything else is "the reader failed", with the error's own
 * (English) message appended only in en.
 */
export function workerReason(e: unknown, locale: "zh" | "en"): string {
  if (e instanceof WorkerTimeoutError) return MESSAGES[locale].timeout;
  const failed = MESSAGES[locale].readerFailed;
  if (locale === "zh") return failed;
  const detail = e instanceof Error ? e.message : String(e);
  return detail === "" ? failed : `${failed}: ${detail}`;
}

function line(doc: Document, className: string, text: string, role?: string): HTMLElement {
  const el = doc.createElement("div");
  el.className = className;
  el.textContent = text;
  if (role !== undefined) el.setAttribute("role", role);
  return el;
}

/** Replaces the content of `root` with a spinner-free loading line. */
export function showLoading(root: HTMLElement, t: Translate): void {
  root.dataset.state = "loading";
  root.replaceChildren(line(root.ownerDocument, "cap-state cap-loading", t("loading"), "status"));
}

export function showEmpty(root: HTMLElement, t: Translate): void {
  root.dataset.state = "empty";
  root.replaceChildren(line(root.ownerDocument, "cap-state cap-empty", t("empty")));
}

/** The reason is agent- or file-derived text: it only ever goes in through `textContent`. */
export function showError(
  root: HTMLElement,
  t: Translate,
  reason: string,
  onDownloadHint?: () => void,
): void {
  const doc = root.ownerDocument;
  root.dataset.state = "error";
  const box = doc.createElement("div");
  box.className = "cap-state cap-error";
  box.setAttribute("role", "alert");
  box.append(
    line(doc, "cap-error-title", t("errorTitle")),
    line(doc, "cap-error-reason", reason),
    line(doc, "cap-error-hint", t("downloadHint")),
  );
  root.replaceChildren(box);
  onDownloadHint?.();
}
