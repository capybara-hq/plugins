import {
  Avatar,
  type AvatarProps,
  type JsonValue,
  type PrincipalOption,
  type QueryState,
  Stack,
  Text,
  useAction,
  useLocale,
  usePluginQuery,
} from "@capybara-hq/plugin-client";
import { useCallback, useMemo, useState } from "react";
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

/**
 * Runs a query of the contract with typed params and result. People and agents the kernel no
 * longer knows come back named by their raw id; they are renamed "Unknown member" / "Unknown
 * agent" here, so no page shows an id as a name.
 */
export function useCollabQuery<N extends QueryName>(
  name: N,
  params: QueryMap[N]["params"],
  opts?: { staleMs?: number },
): QueryState<QueryMap[N]["result"]> {
  const { locale } = useLocale();
  const q = usePluginQuery<QueryMap[N]["result"]>(name, params as unknown as JsonValue, opts);
  // keyed on the locale string: `t` is not guaranteed stable, and a new result object per render
  // would rerun every effect that depends on the data
  const data = useMemo(
    () =>
      q.data === undefined
        ? undefined
        : (nameUnknown(q.data, "", {
            person: COPY.unknownMember[locale],
            agent: COPY.unknownAgent[locale],
          }) as QueryMap[N]["result"]),
    [q.data, locale],
  );
  return { ...q, data };
}

/** A person or agent reference: `{ id, name, avatar }`. */
function isRef(v: Record<string, unknown>): boolean {
  return typeof v.id === "string" && typeof v.name === "string" && "avatar" in v;
}

/** Copies `value`, renaming refs whose name is their id (the key says person or agent). */
function nameUnknown(
  value: unknown,
  key: string,
  labels: { person: string; agent: string },
): unknown {
  if (Array.isArray(value)) return value.map((v) => nameUnknown(v, key, labels));
  if (typeof value !== "object" || value === null) return value;
  const obj = value as Record<string, unknown>;
  if (isRef(obj) && obj.name === obj.id) {
    return { ...obj, name: /agent/i.test(key) ? labels.agent : labels.person };
  }
  const out: Record<string, unknown> = {};
  // a map keyed by id (`agents: { [agentId]: ref }`) keeps its own key's kind for its values
  for (const [k, v] of Object.entries(obj)) {
    out[k] = nameUnknown(v, /agent/i.test(key) && !/agent/i.test(k) ? key : k, labels);
  }
  return out;
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

/**
 * An avatar as the forwarded `Avatar` / `PrincipalPicker` take it. The host's components are the
 * design's, which draw a preset animal on a square (agent) avatar and the initial on a circle; the
 * published plugin-client types still name only images, so a preset is passed through that type.
 */
export function avatarValue(avatar: AvatarValue): AvatarProps["value"] {
  return avatar as AvatarProps["value"];
}

/** The image route of an avatar, for `PersonName` (a person: a preset draws as the initial anyway). */
export function avatarUrl(avatar: AvatarValue): string | null {
  return avatar !== null && avatar.kind === "image" ? avatar.src : null;
}

export function personOption(p: PersonRef): PrincipalOption {
  return { kind: "person", id: p.id, name: p.name, avatar: avatarValue(p.avatar) };
}

export function agentOption(a: AgentRef): PrincipalOption {
  return { kind: "agent", id: a.id, name: a.name, avatar: avatarValue(a.avatar) };
}

/**
 * An agent on one line: its square avatar (a preset animal, an image or the initial), the name and
 * an optional muted `secondary`. `PersonName` takes only an image route and draws a circle, so it
 * would drop an agent's preset.
 */
export function AgentName({ agent, secondary }: { agent: AgentRef; secondary?: string }) {
  return (
    <Stack direction="row" gap={4} align="center">
      <Avatar value={avatarValue(agent.avatar)} name={agent.name} size={16} />
      <Text truncate title={agent.name}>
        {agent.name}
      </Text>
      {secondary !== undefined && (
        <Text tone="muted" truncate>
          {secondary}
        </Text>
      )}
    </Stack>
  );
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

/**
 * Runs actions for a control and keeps what went wrong: a refusal is the host's toast (the
 * outcome carries it, the control stays as it was), a thrown error is kept in `error` for an
 * inline line ({@link ErrorLine}). `busy` names the running call.
 */
export function useActionRunner(): {
  run(id: string, call: () => Promise<ActionOutcome>): Promise<ActionOutcome | null>;
  busy: string | null;
  error: string | null;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (id: string, call: () => Promise<ActionOutcome>) => {
    setBusy(id);
    setError(null);
    try {
      return await call();
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  return { run, busy, error };
}

/** Says a list was cut at the result size budget (the query's `truncated`). */
export function TruncatedNote({ truncated }: { truncated: boolean | undefined }) {
  const { t } = useLocale();
  if (truncated !== true) return null;
  return (
    <Text variant="small" tone="muted">
      {t(COPY.truncatedList)}
    </Text>
  );
}

/** A failed action's message under the control that ran it. */
export function ErrorLine({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <Text variant="small" tone="fail">
      {error}
    </Text>
  );
}
