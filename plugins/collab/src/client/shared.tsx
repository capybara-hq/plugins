import {
  type JsonValue,
  type PrincipalOption,
  type QueryState,
  useAction,
  useLocale,
  usePluginQuery,
} from "@capybara-hq/plugin-client";
import { useCallback } from "react";
import type {
  ActionId,
  ActionMap,
  AgentRef,
  AgentState,
  AvatarValue,
  NotFound,
  PersonRef,
  QueryMap,
  QueryName,
} from "../page/contract.js";
import { COPY, type Copy } from "./i18n.js";

/** The `org.page` component id of the project pages (links and `navigate({ page })` use it). */
export const PAGE_ID = "projects";
/** The in-app path of the project pages. */
export const PAGE_PATH = `/p/collab/${PAGE_ID}`;

/** `t` of the viewer's locale, for the copy table entries. */
export function useT(): (text: Copy) => string {
  return useLocale().t;
}

/** Runs a query of the contract with typed params and result. */
export function useCollabQuery<N extends QueryName>(
  name: N,
  params: QueryMap[N]["params"],
  opts?: { staleMs?: number },
): QueryState<QueryMap[N]["result"]> {
  return usePluginQuery<QueryMap[N]["result"]>(name, params as unknown as JsonValue, opts);
}

/** The result of a successful action, as the host hands it to the component. */
export interface ActionOutcome {
  toast?: string;
  invalidate?: string[];
}

/** Calls an action of the contract with a typed payload. */
export function useCollabAction(): <A extends ActionId>(
  id: A,
  payload: ActionMap[A],
) => Promise<ActionOutcome> {
  const action = useAction();
  return useCallback(
    (id, payload) => action(id, { payload: payload as unknown as JsonValue }),
    [action],
  );
}

/** A query answer for something hidden from the viewer or missing. */
export function isNotFound(value: unknown): value is NotFound {
  return typeof value === "object" && value !== null && "notFound" in value;
}

/** The avatar shape the forwarded components take (a preset draws as the initial). */
export function imageAvatar(avatar: AvatarValue): { kind: "image"; src: string } | null {
  return avatar !== null && avatar.kind === "image" ? avatar : null;
}

export function personOption(p: PersonRef): PrincipalOption {
  return { kind: "person", id: p.id, name: p.name, avatar: imageAvatar(p.avatar) };
}

export function agentOption(a: AgentRef): PrincipalOption {
  return { kind: "agent", id: a.id, name: a.name, avatar: imageAvatar(a.avatar) };
}

export const AGENT_STATE_LABEL: Record<AgentState, Copy> = {
  working: COPY.agentWorking,
  waiting: COPY.agentWaiting,
  idle: COPY.agentIdle,
  declined: COPY.agentDeclined,
};

/** The query-string link to a place of the project pages (the host keeps `?…` on this page). */
export function pageHref(params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return q === "" ? "?" : `?${q}`;
}

/** `?item=KEY` from anywhere in the app. */
export function itemPath(key: string): string {
  return `${PAGE_PATH}?${new URLSearchParams({ item: key }).toString()}`;
}

/** An action's thrown error as text for an inline message. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Labels typed as one comma-separated line. */
export function parseLabels(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  ];
}
