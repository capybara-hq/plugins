import {
  Badge,
  Button,
  ItemList,
  KeyValue,
  Stack,
  Text,
  useCapybaraEvents,
  useNavigate,
  useRunState,
} from "@capybara-hq/plugin-client";
import type { PanelItem } from "../page/contract.js";
import { DecisionItem } from "./decisions.js";
import { COPY, PRIORITY_LABEL } from "./i18n.js";
import { AGENT_STATE_LABEL, PAGE_ID, TruncatedNote, useCollabQuery, useT } from "./shared.js";

/**
 * The item the open conversation serves, or null (also while loading or failed). Read again when
 * a tool call or a run of this conversation finishes (the agent may have changed the item).
 */
function usePanelItem(): { item: PanelItem | null; truncated: boolean | undefined } {
  const q = useCollabQuery("item.byConversation", {});
  const { conversationId } = useRunState();
  const { refetch } = q;
  useCapybaraEvents((e) => {
    if (conversationId !== null && e.conversationId === conversationId) refetch();
  }, REFRESH_ON);
  return { item: q.data?.item ?? null, truncated: q.data?.truncated };
}

const REFRESH_ON = ["tool.finished", "run.finished"] as const;

function ItemFacts({ item }: { item: PanelItem }) {
  const t = useT();
  return (
    <KeyValue
      rows={[
        { k: t(COPY.status), v: t(item.statusName) },
        { k: t(COPY.responsible), v: item.responsible?.name ?? t(COPY.none) },
        {
          k: t(COPY.agent),
          v:
            item.agent === null
              ? t(COPY.none)
              : item.agentState === null
                ? item.agent.name
                : `${item.agent.name} · ${t(AGENT_STATE_LABEL[item.agentState])}`,
        },
        { k: t(COPY.priority), v: t(PRIORITY_LABEL[item.priority] ?? COPY.none) },
      ]}
    />
  );
}

/**
 * The conversation panel of a collab conversation: the item card (key, title, status), its facts
 * and its open decisions with answer buttons. Nothing in other conversations.
 */
export function ItemPanel() {
  const t = useT();
  const navigate = useNavigate();
  const { item, truncated } = usePanelItem();
  if (item === null) return null;
  return (
    <Stack gap={16}>
      <Stack gap={4}>
        <Stack direction="row" gap={8} align="center">
          <Text variant="small" tone="muted">
            {`${item.projectName} · ${item.key}`}
          </Text>
          <Badge tone="accent">{t(item.statusName)}</Badge>
        </Stack>
        <Text variant="h3">{item.title}</Text>
      </Stack>
      <ItemFacts item={item} />
      <TruncatedNote truncated={truncated} />
      {item.openDecisions.length > 0 && (
        <ItemList label={t(COPY.openDecisions)}>
          {item.openDecisions.map((d) => (
            <DecisionItem key={d.id} decision={d} />
          ))}
        </ItemList>
      )}
      <Stack direction="row">
        <Button onClick={() => navigate({ page: { id: PAGE_ID, params: { item: item.key } } })}>
          {t(COPY.openItem)}
        </Button>
      </Stack>
    </Stack>
  );
}

/**
 * The properties section body of a collab conversation (the host draws the section with the
 * manifest's title): the item's title, facts and open decisions. Nothing in other conversations.
 */
export function ItemProperties() {
  const t = useT();
  const navigate = useNavigate();
  const { item, truncated } = usePanelItem();
  if (item === null) return null;
  return (
    <Stack gap={8}>
      <Text truncate title={`${item.key} ${item.title}`}>
        {`${item.key} ${item.title}`}
      </Text>
      <ItemFacts item={item} />
      <TruncatedNote truncated={truncated} />
      {item.openDecisions.length > 0 && (
        <ItemList label={t(COPY.openDecisions)}>
          {item.openDecisions.map((d) => (
            <DecisionItem key={d.id} decision={d} />
          ))}
        </ItemList>
      )}
      <Stack direction="row">
        <Button
          variant="ghost"
          onClick={() => navigate({ page: { id: PAGE_ID, params: { item: item.key } } })}
        >
          {t(COPY.openItem)}
        </Button>
      </Stack>
    </Stack>
  );
}
