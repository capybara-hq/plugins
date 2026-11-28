import {
  Avatar,
  Badge,
  Board,
  type BoardCard as BoardCardShape,
  FilterChip,
  ListPage,
  type PageAction,
  Segmented,
  Stack,
  Text,
  useNavigate,
  usePageParams,
} from "@capybara-hq/plugin-client";
import { type ReactNode, useState } from "react";
import type {
  BoardCard,
  BoardColumn,
  ItemFilter,
  ItemTypeInfo,
  ProjectHeader,
} from "../page/contract.js";
import { COPY, PRIORITY_LABEL } from "./i18n.js";
import { ItemForm } from "./item-form.js";
import {
  AGENT_STATE_LABEL,
  imageAvatar,
  isNotFound,
  pageHref,
  useCollabAction,
  useCollabQuery,
  useT,
} from "./shared.js";

/** The filters a project page reads from its params (`type`, `mine=1`). */
export function useProjectFilter(): { type: string | undefined; filter: ItemFilter } {
  const params = usePageParams();
  return {
    type: params.type,
    filter: params.mine === "1" ? { responsible: "me" } : {},
  };
}

/**
 * The frame both views of a project share: one `ListPage` with the project's header (new item,
 * settings), the board / list switch, the type chips and "mine".
 */
export function ProjectFrame(props: {
  projectKey: string;
  project: ProjectHeader | undefined;
  types: ItemTypeInfo[] | undefined;
  /** The type the view shows (the board always shows one). */
  activeType?: string | undefined;
  canEdit: boolean;
  notFound: boolean;
  loading: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  const navigate = useNavigate();
  const params = usePageParams();
  const [creating, setCreating] = useState(false);
  const view = params.view === "list" ? "list" : "board";
  const mine = params.mine === "1";
  const types = props.types ?? [];
  const activeType = props.activeType ?? params.type;

  if (props.notFound) {
    return (
      <ListPage
        header={{ title: props.projectKey, path: [{ label: t(COPY.projects), href: "?" }] }}
        empty={{ text: t(COPY.notFound), size: "page" }}
      />
    );
  }

  const actions: PageAction[] = [];
  if (props.canEdit && props.project !== undefined) {
    actions.push({ label: t(COPY.newItem), variant: "primary", onSelect: () => setCreating(true) });
  }
  actions.push({
    label: t(COPY.settings),
    variant: "default",
    href: pageHref({ project: props.projectKey, settings: "1" }),
  });

  return (
    <ListPage
      header={{
        title: props.project?.name ?? props.projectKey,
        ...(props.project?.description && { description: props.project.description }),
        actions,
      }}
      variant={view === "board" ? "cards" : "records"}
      listLabel={t(view === "board" ? COPY.board : COPY.itemsTable)}
      loading={props.loading}
      filterCount={(params.type !== undefined ? 1 : 0) + (mine ? 1 : 0)}
      filters={
        <Stack direction="row" gap={8} wrap align="center">
          <Segmented
            label={t(COPY.viewSwitch)}
            density="dense"
            value={view}
            options={[
              { value: "board", label: t(COPY.board) },
              { value: "list", label: t(COPY.list) },
            ]}
            onChange={(v) =>
              navigate({ params: { view: v === "list" ? "list" : null }, replace: true })
            }
          />
          {view === "list" && (
            <FilterChip
              label={t(COPY.allTypes)}
              density="dense"
              selected={params.type === undefined}
              onSelect={() => navigate({ params: { type: null }, replace: true })}
            />
          )}
          {types.map((ty) => (
            <FilterChip
              key={ty.key}
              label={t(ty.name)}
              density="dense"
              selected={activeType === ty.key}
              onSelect={() => navigate({ params: { type: ty.key }, replace: true })}
            />
          ))}
          <FilterChip
            label={t(COPY.mine)}
            density="dense"
            selected={mine}
            onSelect={() => navigate({ params: { mine: mine ? null : "1" }, replace: true })}
          />
        </Stack>
      }
    >
      {props.children}
      {props.project !== undefined && (
        <ItemForm
          open={creating}
          onOpenChange={setCreating}
          project={{ id: props.project.id, key: props.project.key }}
          types={types}
          {...(activeType !== undefined && { defaultType: activeType })}
        />
      )}
    </ListPage>
  );
}

type Card = BoardCard & BoardCardShape;

/**
 * The board of one item type: a column per status of its workflow (a gated column is locked: a
 * drop there asks its confirmer), a card per item; dragging calls `item.move`.
 */
export function ProjectBoard({ project }: { project: string }) {
  const t = useT();
  const navigate = useNavigate();
  const act = useCollabAction();
  const { type, filter } = useProjectFilter();
  const q = useCollabQuery("project.board", {
    project,
    ...(type !== undefined && { type }),
    filter,
  });
  const data = q.data !== undefined && !isNotFound(q.data) ? q.data : undefined;
  const columns = data?.columns ?? [];
  const byKey = new Map<string, BoardColumn>(columns.map((c) => [c.key, c]));
  const cards: Card[] = (data?.cards ?? []).map((c) => ({ ...c, columnId: c.statusKey }));

  const onMove = async (cardId: string, to: string) => {
    const card = cards.find((c) => c.id === cardId);
    if (card === undefined || card.statusKey === to) return;
    const r = await act("item.move", { itemId: card.id, version: card.version, to });
    // A toast is a refusal or a gate request (the item stays): the card snaps back; the host shows
    // the toast and refetches what the action names.
    if (r.toast !== undefined) throw new Error(r.toast);
  };

  return (
    <ProjectFrame
      projectKey={project}
      project={data?.project}
      types={data?.types}
      activeType={data?.type}
      canEdit={data?.canEdit ?? false}
      notFound={q.data !== undefined && isNotFound(q.data)}
      loading={q.status === "loading"}
    >
      {data?.truncated === true && (
        <Text variant="small" tone="muted">
          {t(COPY.truncated)}
        </Text>
      )}
      <Board<Card>
        loading={q.status === "loading"}
        columns={columns.map((c) => ({
          id: c.key,
          title: t(c.name),
          count: cards.filter((card) => card.statusKey === c.key).length,
          locked: c.locked,
          ...(c.locked && { hint: t(COPY.gateHint) }),
        }))}
        cards={cards}
        canMove={(card, to) => {
          if (data?.canEdit !== true) return false;
          const next = byKey.get(card.statusKey)?.next ?? [];
          return next.length === 0 || next.includes(to);
        }}
        onMove={(cardId, to) => onMove(cardId, to)}
        onOpen={(cardId) => {
          const card = cards.find((c) => c.id === cardId);
          if (card !== undefined)
            navigate({ params: { item: card.key, project: null, view: null } });
        }}
        empty={<Text tone="muted">{t(COPY.emptyBoard)}</Text>}
        renderCard={(card) => <CardBody card={card} />}
      />
    </ProjectFrame>
  );
}

/** A card's content: key, title, priority, labels, open decisions and who works on it. */
function CardBody({ card }: { card: Card }) {
  const t = useT();
  return (
    <Stack gap={4}>
      <Stack direction="row" gap={8} justify="between" align="center">
        <Text variant="micro" tone="muted">
          {card.key}
        </Text>
        {card.priority !== 0 && card.priority <= 2 && (
          <Badge tone={card.priority === 1 ? "warn" : "default"}>
            {t(PRIORITY_LABEL[card.priority] ?? COPY.none)}
          </Badge>
        )}
      </Stack>
      <Text>{card.title}</Text>
      <Stack direction="row" gap={4} wrap align="center">
        {card.openDecisions > 0 && <Badge tone="count">{card.openDecisions}</Badge>}
        {card.labels.map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
      </Stack>
      {(card.responsible !== null || card.agent !== null) && (
        <Stack direction="row" gap={4} align="center">
          {card.responsible !== null && (
            <Avatar
              value={imageAvatar(card.responsible.avatar)}
              name={card.responsible.name}
              size={16}
              shape="circle"
            />
          )}
          {card.agent !== null && (
            <>
              <Avatar value={imageAvatar(card.agent.avatar)} name={card.agent.name} size={16} />
              <Text variant="small" tone="muted" truncate>
                {card.agentState === null
                  ? card.agent.name
                  : `${card.agent.name} · ${t(AGENT_STATE_LABEL[card.agentState])}`}
              </Text>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
}
