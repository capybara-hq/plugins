import { type ExtensionContext, ToolError, type ToolHandler } from "@capybara-hq/plugin-sdk";

/**
 * Stubs for the tools declared in `permissions.tools`: each one refuses with "not implemented"
 * until the tool task replaces it with the real spec and handler.
 */
const EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false };

function notImplemented(name: string): ToolHandler {
  return async () => {
    throw new ToolError(
      `plugin__collab__${name} is not implemented yet. Use another tool or ask the user to retry after the plugin is updated.`,
    );
  };
}

const PROJECT_LIST = {
  name: "project_list",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const PROJECT_CREATE = {
  name: "project_create",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const ITEM_SEARCH = {
  name: "item_search",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const ITEM_GET = {
  name: "item_get",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const ITEM_CREATE = {
  name: "item_create",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const ITEM_UPDATE = {
  name: "item_update",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const ITEM_TRANSITION = {
  name: "item_transition",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const ITEM_ASSIGN = {
  name: "item_assign",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const ITEM_COMMENT = {
  name: "item_comment",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const ITEM_LINK = {
  name: "item_link",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const ARTIFACT_ATTACH = {
  name: "artifact_attach",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const DECISION_ASK = {
  name: "decision_ask",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

const DECISION_LIST = {
  name: "decision_list",
  description: "Not implemented yet. Do not call this tool.",
  inputSchema: EMPTY_INPUT,
  defaultPolicy: "ask",
} as const;

export function registerTools(ctx: ExtensionContext): void {
  ctx.tools.register(PROJECT_LIST, notImplemented("project_list"));
  ctx.tools.register(PROJECT_CREATE, notImplemented("project_create"));
  ctx.tools.register(ITEM_SEARCH, notImplemented("item_search"));
  ctx.tools.register(ITEM_GET, notImplemented("item_get"));
  ctx.tools.register(ITEM_CREATE, notImplemented("item_create"));
  ctx.tools.register(ITEM_UPDATE, notImplemented("item_update"));
  ctx.tools.register(ITEM_TRANSITION, notImplemented("item_transition"));
  ctx.tools.register(ITEM_ASSIGN, notImplemented("item_assign"));
  ctx.tools.register(ITEM_COMMENT, notImplemented("item_comment"));
  ctx.tools.register(ITEM_LINK, notImplemented("item_link"));
  ctx.tools.register(ARTIFACT_ATTACH, notImplemented("artifact_attach"));
  ctx.tools.register(DECISION_ASK, notImplemented("decision_ask"));
  ctx.tools.register(DECISION_LIST, notImplemented("decision_list"));
}
