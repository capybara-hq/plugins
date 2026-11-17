import type { EmbedParentMessage } from "@capybara-hq/plugin-sdk";
import type { PreviewFile } from "./types.js";

// Not imported from the SDK: its value entry pulls node modules into the browser bundle. The type
// ties this literal to the SDK's EMBED_PROTOCOL, so a protocol bump fails the typecheck.
const EMBED_PROTOCOL: EmbedParentMessage["protocol"] = "capybara-embed/1";

export type BridgeEvent =
  | {
      type: "init";
      locale: "zh" | "en";
      theme: "dark" | "light";
      tokens: Record<string, string>;
    }
  | { type: "theme"; theme: "dark" | "light"; tokens: Record<string, string> }
  | { type: "file"; file: PreviewFile };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
// cross-realm safe (an ArrayBuffer from another window fails instanceof)
const isBuffer = (v: unknown): v is ArrayBuffer =>
  Object.prototype.toString.call(v) === "[object ArrayBuffer]";

function parseTokens(v: unknown): Record<string, string> | null {
  if (!isObj(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
}

function parseTheme(v: unknown): "dark" | "light" | null {
  return v === "dark" || v === "light" ? v : null;
}

/** Parses one message of the outer page; null for anything the shell does not act on. */
function parse(data: unknown): BridgeEvent | null {
  if (!isObj(data) || data.protocol !== EMBED_PROTOCOL) return null;
  const m = data as Partial<Record<string, unknown>> & { type?: EmbedParentMessage["type"] };
  switch (m.type) {
    case "init": {
      const theme = parseTheme(m.theme);
      const tokens = parseTokens(m.tokens);
      if ((m.locale !== "zh" && m.locale !== "en") || !theme || !tokens) return null;
      return { type: "init", locale: m.locale, theme, tokens };
    }
    case "theme": {
      const theme = parseTheme(m.theme);
      const tokens = parseTokens(m.tokens);
      return theme && tokens ? { type: "theme", theme, tokens } : null;
    }
    case "file": {
      const { name, contentType, size, data: buf } = m;
      if (typeof name !== "string" || typeof contentType !== "string") return null;
      if (typeof size !== "number" || !Number.isFinite(size) || size < 0 || !isBuffer(buf))
        return null;
      return { type: "file", file: { name, contentType, size, data: buf } };
    }
    default:
      return null;
  }
}

/**
 * Listens for the outer page's messages on `win`. Only messages from `win.parent` with the embed
 * protocol and a known type count; `file` is delivered once and only after `init`. Returns the
 * function that stops listening.
 */
export function createBridge(win: Window, onEvent: (e: BridgeEvent) => void): () => void {
  let initialized = false;
  let fileSeen = false;
  const listener = (e: MessageEvent) => {
    if (e.source !== win.parent) return;
    const event = parse(e.data);
    if (!event) return;
    if (event.type === "init") {
      initialized = true;
    } else if (event.type === "file") {
      if (!initialized || fileSeen) return;
      fileSeen = true;
    }
    onEvent(event);
  };
  win.addEventListener("message", listener);
  return () => win.removeEventListener("message", listener);
}
