import { ItemList } from "@capybara-hq/plugin-client";
import { COPY } from "./i18n.js";
import { AGENT_STATE_LABEL, itemPath, useCollabQuery, useT } from "./shared.js";

/** The agent page's section: the open items this agent executes, in projects the viewer sees. */
export function AgentItems() {
  const t = useT();
  const q = useCollabQuery("agent.items", {});
  const items = q.data?.items ?? [];
  if (q.status !== "ready") return null;
  return (
    <ItemList
      label={t(COPY.agentItems)}
      empty={t(COPY.noAgentItems)}
      rows={items.map((i) => ({
        id: i.id,
        title: i.title,
        tag: { label: i.key },
        meta: [
          i.responsible?.name,
          i.agentState === null ? undefined : t(AGENT_STATE_LABEL[i.agentState]),
        ]
          .filter((x): x is string => x !== undefined)
          .join(" · "),
        status: {
          label: t(i.statusName),
          tone:
            i.statusCategory === "in_progress" || i.statusCategory === "review"
              ? "accent"
              : "default",
        },
        href: itemPath(i.key),
      }))}
    />
  );
}
