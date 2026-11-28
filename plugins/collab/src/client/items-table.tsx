import {
  Badge,
  CellTitle,
  DataTable,
  PersonName,
  Text,
  useNavigate,
} from "@capybara-hq/plugin-client";
import { useState } from "react";
import type { ItemFilter, ItemRow, ItemSortField } from "../page/contract.js";
import { ProjectFrame } from "./board.js";
import { COPY, PRIORITY_LABEL } from "./i18n.js";
import {
  AGENT_STATE_LABEL,
  AgentName,
  avatarUrl,
  isNotFound,
  TruncatedNote,
  useCollabQuery,
  useT,
} from "./shared.js";

const PAGE_SIZE = 50;
const SORTABLE: Record<string, ItemSortField> = {
  key: "key",
  title: "title",
  status: "status",
  priority: "priority",
  updated: "updated",
};

/**
 * The list view of a project: every item (all types unless one is chosen), paged and sortable,
 * in the project page's frame.
 */
export function ItemsTable(props: {
  project: string;
  type: string | undefined;
  filter: ItemFilter;
}) {
  const t = useT();
  const navigate = useNavigate();
  // the page belongs to one filter: a new filter starts on page 1
  const filterKey = JSON.stringify([props.type ?? null, props.filter]);
  const [paging, setPaging] = useState({ filterKey, page: 1 });
  const page = paging.filterKey === filterKey ? paging.page : 1;
  const setPage = (p: number) => setPaging({ filterKey, page: p });
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({
    key: "updated",
    dir: "desc",
  });
  const q = useCollabQuery("project.items", {
    project: props.project,
    page,
    pageSize: PAGE_SIZE,
    sort: { field: SORTABLE[sort.key] ?? "updated", dir: sort.dir },
    filter: { ...props.filter, ...(props.type !== undefined && { type: props.type }) },
  });
  const data = q.data !== undefined && !isNotFound(q.data) ? q.data : undefined;

  return (
    <ProjectFrame
      projectKey={props.project}
      project={data?.project}
      types={data?.types}
      canEdit={data?.canEdit ?? false}
      notFound={q.data !== undefined && isNotFound(q.data)}
      loading={q.status === "loading"}
    >
      <TruncatedNote truncated={data?.truncated} />
      <DataTable<ItemRow>
        label={t(COPY.itemsTable)}
        state={q.status === "error" ? "error" : q.status === "loading" ? "loading" : "ready"}
        error={{ code: q.error ?? "ui.query_failed", onRetry: q.refetch }}
        rows={data?.rows ?? []}
        rowKey={(r) => r.id}
        onOpen={(r) => navigate({ params: { item: r.key, project: null, view: null } })}
        empty={{ title: t(COPY.emptyBoard) }}
        sort={{ key: sort.key, dir: sort.dir, onChange: (key, dir) => setSort({ key, dir }) }}
        {...(data !== undefined && {
          pagination: {
            page: data.page,
            pageSize: data.pageSize,
            total: data.total,
            onPage: setPage,
          },
        })}
        columns={[
          {
            key: "key",
            header: t(COPY.key),
            sortable: true,
            fit: true,
            compact: "meta",
            cell: (r) => <Text variant="small">{r.key}</Text>,
          },
          {
            key: "title",
            header: t(COPY.title),
            sortable: true,
            compact: "title",
            cell: (r) => (
              <CellTitle
                title={r.title}
                {...(r.labels.length > 0 && { description: r.labels.join(", ") })}
              />
            ),
          },
          {
            key: "status",
            header: t(COPY.status),
            sortable: true,
            compact: "subtitle",
            cell: (r) => (
              <Badge
                tone={
                  r.statusCategory === "in_progress" || r.statusCategory === "review"
                    ? "accent"
                    : "default"
                }
              >
                {t(r.statusName)}
              </Badge>
            ),
          },
          {
            key: "responsible",
            header: t(COPY.responsible),
            compact: "hidden",
            cell: (r) =>
              r.responsible === null ? (
                <Text tone="faint">{t(COPY.none)}</Text>
              ) : (
                <PersonName
                  name={r.responsible.name}
                  avatarUrl={avatarUrl(r.responsible.avatar)}
                  size={16}
                />
              ),
          },
          {
            key: "agent",
            header: t(COPY.agent),
            compact: "hidden",
            cell: (r) =>
              r.agent === null ? (
                <Text tone="faint">{t(COPY.none)}</Text>
              ) : (
                <AgentName
                  agent={r.agent}
                  {...(r.agentState !== null && { secondary: t(AGENT_STATE_LABEL[r.agentState]) })}
                />
              ),
          },
          {
            key: "priority",
            header: t(COPY.priority),
            sortable: true,
            compact: "hidden",
            cell: (r) => t(PRIORITY_LABEL[r.priority] ?? COPY.none),
          },
          {
            key: "updated",
            header: t(COPY.updated),
            sortable: true,
            align: "right",
            tone: "muted",
            compact: "trailing",
            cell: (r) => new Date(r.updatedAt).toLocaleDateString(),
          },
        ]}
      />
    </ProjectFrame>
  );
}
