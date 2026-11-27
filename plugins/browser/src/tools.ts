// The browser's agent tools (browser use spec §9): each one request to the daemon in the
// conversation's device. Read-only and navigation tools declare `allow`; tools that act on a page
// declare `ask`, so the conversation's permission profile decides.
import { ToolError, type ToolHandler, type ToolSpec } from "@capybara-hq/plugin-sdk";
import type { ToolOp } from "../daemon/protocol.js";
import { REPLY_TOO_LARGE_MESSAGE, VIEWPORT } from "../daemon/protocol.js";
import {
  type BrowserDeps,
  REQUEST_TIMEOUT_MS,
  runRequest,
  TOOL_TIMEOUT_MS,
  toResult,
} from "./browser.js";
import { WAIT_DEFAULT_MS, WAIT_MAX_MS, waitHandler, waitWatcher } from "./wait.js";
import type { WatchTools } from "./watched-wait-sdk.js";

export { WAIT_INLINE_MAX_MS, WAIT_MAX_MS } from "./wait.js";

/**
 * The largest screenshot the daemon may return, in decoded bytes: below the kernel's image limit
 * and small enough for every provider's request path (base64 inside the reply).
 */
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

const REF = {
  type: "string",
  description: 'An element ref from the latest browser_snapshot, e.g. "e12".',
} as const;

const NAVIGATE: ToolSpec = {
  name: "browser_navigate",
  title: "Open a page",
  description:
    "Open a URL in the active tab of the browser running in the user's device, or go back, " +
    "forward or reload. Use it to start browsing or to go to a known address; then call " +
    "browser_snapshot to read the page. Do not use it to follow a link on the page (use " +
    "browser_click on the link's ref). Only http and https URLs open.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: 'The address to open, e.g. "https://example.com".' },
      action: {
        type: "string",
        enum: ["back", "forward", "reload"],
        description: "Instead of a url: go back, forward or reload the page.",
      },
    },
    additionalProperties: false,
  },
  keyArgs: ["url", "action"],
  defaultPolicy: "allow",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const TABS: ToolSpec = {
  name: "browser_tabs",
  title: "Browser tabs",
  description:
    "List, open, switch, close or adopt tabs of the browser in the user's device. Each " +
    "conversation has its own tabs (at most 6, and 10 in the browser) and its own active tab, " +
    "which the other tools act on. Use list to see the tab ids, open to load a url in a new tab, " +
    "switch to make one of this conversation's tabs active and close to close one. list also " +
    "shows tabs of other conversations; adopt moves one of them (tabId) to this conversation and " +
    "makes it active, for when the user points you to a page they opened elsewhere.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "open", "switch", "close", "adopt"],
        description: "What to do.",
      },
      tabId: { type: "string", description: "The tab for switch, close and adopt, from list." },
      url: { type: "string", description: "The address for open (optional: a blank tab)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  keyArgs: ["action", "tabId", "url"],
  defaultPolicy: "allow",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const SNAPSHOT: ToolSpec = {
  name: "browser_snapshot",
  title: "Read the page",
  description:
    "Read the active page as an accessibility tree in text, with a ref (e.g. e12) on every " +
    "element you can act on. Call it after opening a page and after any action that changes the " +
    "page: refs from older snapshots may no longer exist. Prefer it to browser_screenshot unless " +
    "the layout or an image matters.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  defaultPolicy: "allow",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const SCREENSHOT: ToolSpec = {
  name: "browser_screenshot",
  title: "Screenshot",
  description:
    "Take a JPEG screenshot of the active page (viewport 1280x800 " +
    "CSS pixels, or the full page). Use it when the visual layout, an image or a canvas matters, " +
    "or to find coordinates for browser_click_at and browser_type_at. To read text and find " +
    "elements, use browser_snapshot instead.",
  inputSchema: {
    type: "object",
    properties: {
      fullPage: { type: "boolean", description: "Capture the whole page instead of the viewport." },
    },
    additionalProperties: false,
  },
  defaultPolicy: "allow",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const CLICK: ToolSpec = {
  name: "browser_click",
  title: "Click",
  description:
    "Click the element with the given ref from the latest browser_snapshot (links, buttons, " +
    "checkboxes). Waits for a navigation it starts. Use browser_click_at only for things the " +
    "snapshot does not list.",
  inputSchema: {
    type: "object",
    properties: { ref: REF },
    required: ["ref"],
    additionalProperties: false,
  },
  keyArgs: ["ref"],
  defaultPolicy: "ask",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const TYPE: ToolSpec = {
  name: "browser_type",
  title: "Type",
  description:
    "Replace the text of the input or text area with the given ref, optionally pressing Enter " +
    "afterwards (submit). Use browser_select for drop-downs and browser_press for single keys.",
  inputSchema: {
    type: "object",
    properties: {
      ref: REF,
      text: { type: "string", description: "The text to fill in." },
      submit: { type: "boolean", description: "Press Enter after typing (e.g. to search)." },
    },
    required: ["ref", "text"],
    additionalProperties: false,
  },
  keyArgs: ["ref", "text"],
  defaultPolicy: "ask",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const SELECT: ToolSpec = {
  name: "browser_select",
  title: "Select",
  description:
    "Choose options of the select element with the given ref, by value or label. Several " +
    "values only for a multiple select.",
  inputSchema: {
    type: "object",
    properties: {
      ref: REF,
      values: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: 'The option values or labels, e.g. ["Germany"].',
      },
    },
    required: ["ref", "values"],
    additionalProperties: false,
  },
  keyArgs: ["ref", "values"],
  defaultPolicy: "ask",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const PRESS: ToolSpec = {
  name: "browser_press",
  title: "Press a key",
  description:
    "Press a key or a key combination on the active page, e.g. Enter, Escape, ArrowDown, " +
    "Tab or Control+A. Use browser_type to enter text.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: 'A key name (KeyboardEvent.key), e.g. "Enter" or "Control+A".',
      },
    },
    required: ["key"],
    additionalProperties: false,
  },
  keyArgs: ["key"],
  defaultPolicy: "ask",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const SCROLL: ToolSpec = {
  name: "browser_scroll",
  title: "Scroll",
  description:
    "Scroll the page, or scroll the element with the given ref into view and then by dy. " +
    "Use it to load more content of a long page; browser_snapshot already lists elements outside " +
    "the viewport, so scrolling is not needed to read them.",
  inputSchema: {
    type: "object",
    properties: {
      ref: REF,
      dy: { type: "number", description: "Pixels to scroll down (negative scrolls up), e.g. 600." },
    },
    required: ["dy"],
    additionalProperties: false,
  },
  keyArgs: ["ref", "dy"],
  defaultPolicy: "ask",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const HOVER: ToolSpec = {
  name: "browser_hover",
  title: "Hover",
  description:
    "Move the mouse over the element with the given ref, e.g. to open a menu that appears on " +
    "hover. Call browser_snapshot afterwards to see what appeared.",
  inputSchema: {
    type: "object",
    properties: { ref: REF },
    required: ["ref"],
    additionalProperties: false,
  },
  keyArgs: ["ref"],
  defaultPolicy: "ask",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const UPLOAD: ToolSpec = {
  name: "browser_upload",
  title: "Upload a file",
  description:
    "Set a file on the file input with the given ref. The path must be an absolute path of a " +
    "file inside the device's workspace; copy a file there first if it is elsewhere. Use it when " +
    "the page asks for a file (a file chooser opened, or an upload field).",
  inputSchema: {
    type: "object",
    properties: {
      ref: REF,
      path: { type: "string", description: "Absolute path of a file in the workspace." },
    },
    required: ["ref", "path"],
    additionalProperties: false,
  },
  keyArgs: ["ref", "path"],
  defaultPolicy: "ask",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const POINT = {
  x: {
    type: "number",
    minimum: 0,
    maximum: VIEWPORT.width,
    description: `Viewport x in CSS pixels (0-${VIEWPORT.width}), from a viewport screenshot.`,
  },
  y: {
    type: "number",
    minimum: 0,
    maximum: VIEWPORT.height,
    description: `Viewport y in CSS pixels (0-${VIEWPORT.height}), from a viewport screenshot.`,
  },
} as const;

const CLICK_AT: ToolSpec = {
  name: "browser_click_at",
  title: "Click at a point",
  description:
    "Click at viewport coordinates taken from a viewport browser_screenshot. Use it only for " +
    "targets the snapshot does not list (canvas, maps, custom widgets); otherwise use " +
    "browser_click with a ref.",
  inputSchema: {
    type: "object",
    properties: POINT,
    required: ["x", "y"],
    additionalProperties: false,
  },
  keyArgs: ["x", "y"],
  defaultPolicy: "ask",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const TYPE_AT: ToolSpec = {
  name: "browser_type_at",
  title: "Type at a point",
  description:
    "Click at viewport coordinates from a viewport browser_screenshot, then type text there. " +
    "Use it only for fields the snapshot does not list; otherwise use browser_type with a ref.",
  inputSchema: {
    type: "object",
    properties: { ...POINT, text: { type: "string", description: "The text to type." } },
    required: ["x", "y", "text"],
    additionalProperties: false,
  },
  keyArgs: ["x", "y", "text"],
  defaultPolicy: "ask",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

const WAIT: ToolSpec = {
  name: "browser_wait",
  title: "Wait",
  description:
    "Wait until a text appears on the page, an element ref appears, the URL contains a string, " +
    "a navigation finishes or a download finishes, or until the time cap passes. Pass at most " +
    "one condition. A wait of 60000 ms or less runs in the call. A longer wait needs a condition: " +
    "it parks the run without using turns and returns when the condition holds or the time " +
    "passes, so prefer one long wait over repeated short ones; the user can end it early. A long " +
    "wait also ends when the device reaches its running limit (often 2 hours) or the input " +
    "timeout; in a scheduled task it holds the task's next runs back. Use it after an action " +
    "that loads content slowly, or while the user controls the browser. To have the user do " +
    "something in the browser, use browser_handoff instead.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Wait for this text on the page." },
      ref: REF,
      urlContains: {
        type: "string",
        description: 'Wait until the active tab\'s URL contains this string, e.g. "/orders/paid".',
      },
      navigation: { type: "boolean", description: "Wait for the next navigation to finish." },
      download: {
        type: "boolean",
        description: "Wait for the next download to finish saving into the workspace.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 0,
        maximum: WAIT_MAX_MS,
        description: `The time cap in milliseconds (default ${WAIT_DEFAULT_MS}); over 60000 needs a condition.`,
      },
    },
    additionalProperties: false,
  },
  keyArgs: ["text", "urlContains", "timeoutMs"],
  defaultPolicy: "allow",
  // any tool may start the device first (see TOOL_TIMEOUT_MS)
  timeoutMs: TOOL_TIMEOUT_MS,
};

/** The input as an object (the kernel validated it against the schema already). */
const obj = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Copies the defined fields only (exactOptionalPropertyTypes, and a clean daemon request). */
function defined<T extends Record<string, unknown>>(o: T): Defined<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Defined<T>;
}

/** `T` with its possibly undefined fields made optional and never undefined. */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

function need<T>(v: T | undefined, field: string, tool: string): T {
  if (v === undefined) throw new ToolError(`${tool} needs ${field}; pass it and retry.`);
  return v;
}

type TabAction = Extract<ToolOp, { op: "tabs" }>["action"];

/** Whether a browser_tabs action names a tab. */
const namesTab = (a: TabAction) => a === "switch" || a === "close" || a === "adopt";

/** A handler that maps the input to one daemon request and returns the page result. */
function handler(
  deps: BrowserDeps,
  toRequest: (i: Record<string, unknown>) => ToolOp,
  timeoutOf: (r: ToolOp) => number = () => REQUEST_TIMEOUT_MS,
): ToolHandler {
  return async (input, call) => {
    const req = toRequest(obj(input));
    return toResult(await runRequest(deps, call, req, timeoutOf(req)));
  };
}

/** Registers the browser tools other than browser_handoff (see handoff.ts). */
export function registerBrowserTools(ctx: { tools: WatchTools }, deps: BrowserDeps): void {
  ctx.tools.register(
    NAVIGATE,
    handler(deps, (i) => {
      const url = str(i.url);
      const action = str(i.action) as "back" | "forward" | "reload" | undefined;
      if ((url === undefined) === (action === undefined))
        throw new ToolError("browser_navigate needs either a url or an action; pass exactly one.");
      return defined({ op: "navigate" as const, url, action });
    }),
  );
  ctx.tools.register(
    TABS,
    handler(deps, (i) => {
      const action = need(str(i.action), "an action", "browser_tabs") as TabAction;
      const tabId = str(i.tabId);
      if (namesTab(action) && (tabId === undefined || tabId === ""))
        throw new ToolError(
          `browser_tabs needs a tabId for ${action}; call browser_tabs with action list for the tab ids, then retry.`,
        );
      return defined({ op: "tabs" as const, action, tabId, url: str(i.url) });
    }),
  );
  ctx.tools.register(
    SNAPSHOT,
    handler(deps, () => ({ op: "snapshot" })),
  );
  ctx.tools.register(SCREENSHOT, async (input, call) => {
    const i = obj(input);
    const shot = (maxBytes: number) =>
      runRequest(
        deps,
        call,
        defined({
          op: "screenshot" as const,
          fullPage: i.fullPage === true ? true : undefined,
          maxBytes,
        }),
      );
    try {
      return toResult(await shot(SCREENSHOT_MAX_BYTES));
    } catch (e) {
      // a reply that did not fit the service message: once more at half the size
      if (!(e instanceof ToolError) || !e.message.startsWith(REPLY_TOO_LARGE_MESSAGE)) throw e;
      return toResult(await shot(Math.floor(SCREENSHOT_MAX_BYTES / 2)));
    }
  });
  ctx.tools.register(
    CLICK,
    handler(deps, (i) => ({
      op: "click",
      ref: need(str(i.ref), "a ref", "browser_click"),
    })),
  );
  ctx.tools.register(
    TYPE,
    handler(deps, (i) =>
      defined({
        op: "type" as const,
        ref: need(str(i.ref), "a ref", "browser_type"),
        text: need(str(i.text), "text", "browser_type"),
        submit: typeof i.submit === "boolean" ? i.submit : undefined,
      }),
    ),
  );
  ctx.tools.register(
    SELECT,
    handler(deps, (i) => ({
      op: "select",
      ref: need(str(i.ref), "a ref", "browser_select"),
      values: Array.isArray(i.values)
        ? i.values.filter((v): v is string => typeof v === "string")
        : [],
    })),
  );
  ctx.tools.register(
    PRESS,
    handler(deps, (i) => ({
      op: "press",
      key: need(str(i.key), "a key", "browser_press"),
    })),
  );
  ctx.tools.register(
    SCROLL,
    handler(deps, (i) =>
      defined({
        op: "scroll" as const,
        ref: str(i.ref),
        dy: need(num(i.dy), "dy", "browser_scroll"),
      }),
    ),
  );
  ctx.tools.register(
    HOVER,
    handler(deps, (i) => ({
      op: "hover",
      ref: need(str(i.ref), "a ref", "browser_hover"),
    })),
  );
  ctx.tools.register(
    UPLOAD,
    handler(deps, (i) => ({
      op: "upload",
      ref: need(str(i.ref), "a ref", "browser_upload"),
      path: need(str(i.path), "a path", "browser_upload"),
    })),
  );
  ctx.tools.register(
    CLICK_AT,
    handler(deps, (i) => ({
      op: "click_at",
      x: need(num(i.x), "x", "browser_click_at"),
      y: need(num(i.y), "y", "browser_click_at"),
    })),
  );
  ctx.tools.register(
    TYPE_AT,
    handler(deps, (i) => ({
      op: "type_at",
      x: need(num(i.x), "x", "browser_type_at"),
      y: need(num(i.y), "y", "browser_type_at"),
      text: need(str(i.text), "text", "browser_type_at"),
    })),
  );
  // a long wait parks the run; its watcher polls the daemon's watch (browser long waits spec §6)
  ctx.tools.register(WAIT, waitHandler(deps), { watch: waitWatcher(deps) });
}
