import {
  Badge,
  Button,
  ItemList,
  KeyValue,
  PropertySection,
  Stack,
  Text,
  useNavigate,
} from "@capybara-hq/plugin-client";
import type { PanelItem } from "../page/contract.js";
import { DecisionItem } from "./decisions.js";
import { COPY, PRIORITY_LABEL } from "./i18n.js";
import { AGENT_STATE_LABEL, PAGE_ID, useCollabQuery, useT } from "./shared.js";

/** The item the open conversation serves, or null (also while loading or failed). */
function usePanelItem(): {
  item: PanelItem | null;
  status: "loading" | "ready" | "error";
  retry(): void;
} {
  const q = useCollabQuery("item.byConversation", {});
  return { item: q.data?.item ?? null, status: q.status, retry: q.refetch };
}

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
  const { item } = usePanelItem();
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
      {item.openDecisions.length > 0 && (
        <ItemList label={t(COPY.openDecisions)}>
          {item.openDecisions.map((d) => (
            <DecisionItem key={d.id} decision={d} />
          ))}
        </ItemList>
      )}
      <Stack direction="row">
        <Button onClick={() => navigate({ page: { id: PAGE_ID, params: { item: item.key } } })}>
          {t({ zh: "打开事项", en: "Open the item" })}
        </Button>
      </Stack>
    </Stack>
  );
}

/** The properties section of a collab conversation: the item's key as value, facts, decisions. */
export function ItemProperties() {
  const t = useT();
  const navigate = useNavigate();
  const { item } = usePanelItem();
  if (item === null) return null;
  return (
    <PropertySection title={t(COPY.panelTitle)} value={item.key}>
      <Stack gap={8}>
        <Text truncate title={item.title}>
          {item.title}
        </Text>
        <ItemFacts item={item} />
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
            {t({ zh: "打开事项", en: "Open the item" })}
          </Button>
        </Stack>
      </Stack>
    </PropertySection>
  );
}
