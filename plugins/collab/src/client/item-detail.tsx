import {
  Badge,
  Button,
  DetailPage,
  EmptyState,
  ItemList,
  ItemListItem,
  type ItemListRow,
  KeyValue,
  Markdown,
  type MenuItem,
  type PageAction,
  PersonName,
  Stack,
  Text,
  Textarea,
  useNavigate,
} from "@capybara-hq/plugin-client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEntry, ItemDetailResult, ItemRef, StatusInfo } from "../page/contract.js";
import { DecisionItem } from "./decisions.js";
import { COPY, type Copy, PRIORITY_LABEL } from "./i18n.js";
import { ItemForm } from "./item-form.js";
import {
  AGENT_STATE_LABEL,
  ErrorLine,
  errorText,
  imageAvatar,
  isNotFound,
  pageHref,
  TruncatedNote,
  useActionRunner,
  useCollabAction,
  useCollabQuery,
  useT,
} from "./shared.js";

type TabId = "overview" | "activity" | "artifacts" | "decisions" | "conversations";
const TABS: { id: TabId; label: Copy }[] = [
  { id: "overview", label: COPY.overview },
  { id: "activity", label: COPY.activity },
  { id: "artifacts", label: COPY.artifacts },
  { id: "decisions", label: COPY.decisions },
  { id: "conversations", label: COPY.conversations },
];

/** The item page (`item=KEY-n`): facts, then the tabs 概览 / 活动 / 产物 / 决策 / 会话. */
export function ItemDetail({ itemKey }: { itemKey: string }) {
  const t = useT();
  const q = useCollabQuery("item.detail", { key: itemKey });
  const [tab, setTab] = useState<TabId>("overview");

  if (q.data !== undefined && isNotFound(q.data)) {
    return (
      <DetailPage header={{ title: itemKey, path: [{ label: t(COPY.projects), href: "?" }] }}>
        <EmptyState text={t(COPY.notFound)} size="page" />
      </DetailPage>
    );
  }
  if (q.status === "error") {
    return (
      <DetailPage header={{ title: itemKey }}>
        <EmptyState
          text={t(COPY.loadFailed)}
          {...(q.error !== undefined && { hint: q.error })}
          action={{ label: t(COPY.retry), variant: "default", onSelect: q.refetch }}
          size="page"
        />
      </DetailPage>
    );
  }
  const data = q.data;
  if (data === undefined) {
    return <DetailPage header={{ title: itemKey }} loading={{ facts: true, blocks: 3 }} />;
  }
  return <LoadedDetail data={data} tab={tab} onTab={setTab} />;
}

function LoadedDetail(props: { data: ItemDetailResult; tab: TabId; onTab(id: TabId): void }) {
  const t = useT();
  const act = useCollabAction();
  const { data, tab } = props;
  const { item, project } = data;
  const [editing, setEditing] = useState(false);
  const status = data.statuses.find((s) => s.key === item.statusKey);
  const openDecisions = data.decisions.filter((d) => d.state === "open").length;

  const mover = useActionRunner();
  const move = (to: StatusInfo) => () =>
    void mover.run("move", () =>
      act("item.move", { itemId: item.id, version: item.version, to: to.key }),
    );
  const allowed = (s: StatusInfo) =>
    s.key !== item.statusKey &&
    (status === undefined || status.next.length === 0 || status.next.includes(s.key));
  const moveItems: MenuItem[] = data.statuses.filter(allowed).map((s) => ({
    label: t(s.name),
    ...(s.gate !== null && { description: t(COPY.gate) }),
    onSelect: move(s),
  }));

  const actions: PageAction[] = [];
  if (data.canEdit) {
    actions.push({ label: t(COPY.edit), variant: "default", onSelect: () => setEditing(true) });
    if (moveItems.length > 0) actions.push({ label: t(COPY.moveTo), menu: moveItems });
  }

  const agentLine =
    item.agent === null ? (
      <Text tone="faint">{t(COPY.none)}</Text>
    ) : (
      <PersonName
        name={item.agent.name}
        avatarUrl={imageAvatar(item.agent.avatar)?.src ?? null}
        size={16}
        {...(item.agentState !== null && { secondary: t(AGENT_STATE_LABEL[item.agentState]) })}
      />
    );

  return (
    <DetailPage
      header={{
        path: [{ label: project.name, href: pageHref({ project: project.key }) }],
        title: `${item.key} ${item.title}`,
        status: (
          <Badge tone="accent">{status === undefined ? item.statusKey : t(status.name)}</Badge>
        ),
        actions,
      }}
      tabs={{
        label: t(COPY.detailTabs),
        value: tab,
        onChange: (id) => props.onTab((TABS.find((x) => x.id === id)?.id ?? "overview") as TabId),
        items: TABS.map((x) => ({
          id: x.id,
          label: t(x.label),
          ...(x.id === "decisions" && openDecisions > 0 && { count: openDecisions }),
          ...(x.id === "artifacts" &&
            data.artifacts.length > 0 && { count: data.artifacts.length }),
        })),
      }}
      facts={
        <KeyValue
          columns={2}
          rows={[
            { k: t(COPY.status), v: status === undefined ? item.statusKey : t(status.name) },
            {
              k: t(COPY.responsible),
              v:
                item.responsible === null ? (
                  <Text tone="faint">{t(COPY.none)}</Text>
                ) : (
                  <PersonName
                    name={item.responsible.name}
                    avatarUrl={imageAvatar(item.responsible.avatar)?.src ?? null}
                    size={16}
                  />
                ),
            },
            { k: t(COPY.agent), v: agentLine },
            { k: t(COPY.priority), v: t(PRIORITY_LABEL[item.priority] ?? COPY.none) },
            { k: t(COPY.type), v: t(data.type.name) },
            {
              k: t(COPY.parent),
              v:
                data.parent === null ? (
                  <Text tone="faint">{t(COPY.none)}</Text>
                ) : (
                  `${data.parent.key} ${data.parent.title}`
                ),
            },
            ...(item.labels.length > 0 ? [{ k: t(COPY.labels), v: item.labels.join(", ") }] : []),
          ]}
        />
      }
    >
      <ErrorLine error={mover.error} />
      <TruncatedNote truncated={data.truncated} />
      {tab === "overview" && <OverviewTab data={data} />}
      {tab === "activity" && (
        <ActivityTab itemKey={item.key} itemId={item.id} canEdit={data.canEdit} />
      )}
      {tab === "artifacts" && <ArtifactsTab data={data} />}
      {tab === "decisions" && (
        <ItemList label={t(COPY.decisions)} empty={t(COPY.noDecisions)}>
          {data.decisions.length === 0
            ? null
            : data.decisions.map((d) => <DecisionItem key={d.id} decision={d} />)}
        </ItemList>
      )}
      {tab === "conversations" && <ConversationsTab itemKey={item.key} />}
      <ItemForm
        open={editing}
        onOpenChange={setEditing}
        project={{ id: project.id, key: project.key }}
        types={[data.type]}
        item={item}
      />
    </DetailPage>
  );
}

const refRow = (r: ItemRef, t: (c: Copy) => string): ItemListRow => ({
  id: r.id,
  title: r.title,
  meta: r.key,
  status: {
    label: t(r.statusName),
    tone:
      r.statusCategory === "in_progress" || r.statusCategory === "review" ? "accent" : "default",
  },
  href: pageHref({ item: r.key }),
});

function OverviewTab({ data }: { data: ItemDetailResult }) {
  const t = useT();
  return (
    <Stack gap={24}>
      {data.item.description.trim() === "" ? (
        <Text tone="muted">{t(COPY.noDescription)}</Text>
      ) : (
        <Markdown text={data.item.description} />
      )}
      <ItemList
        label={t(COPY.children)}
        empty={t(COPY.noChildren)}
        rows={data.children.map((c) => refRow(c, t))}
      />
      {data.links.length > 0 && (
        <ItemList
          label={t({ zh: "关联事项", en: "Linked items" })}
          rows={data.links.map((l) => ({
            ...refRow(l.item, t),
            id: `${l.kind}-${l.direction}-${l.item.id}`,
            tag: { label: linkLabel(l.kind, l.direction, t) },
          }))}
        />
      )}
    </Stack>
  );
}

function linkLabel(kind: string, direction: "out" | "in", t: (c: Copy) => string): string {
  if (kind === "blocks") {
    return t(
      direction === "out" ? { zh: "阻塞", en: "Blocks" } : { zh: "被阻塞", en: "Blocked by" },
    );
  }
  if (kind === "duplicates") {
    return t(
      direction === "out"
        ? { zh: "重复于", en: "Duplicates" }
        : { zh: "被重复", en: "Duplicated by" },
    );
  }
  return t({ zh: "相关", en: "Relates" });
}

function ArtifactsTab({ data }: { data: ItemDetailResult }) {
  const t = useT();
  return (
    <ItemList
      label={t(COPY.artifacts)}
      empty={t(COPY.noArtifacts)}
      rows={data.artifacts.map((a) => ({
        id: a.id,
        title: a.name,
        tag: { label: a.kind },
        meta: `v${a.version} · ${a.author.agent?.name ?? a.author.person.name} · ${new Date(a.createdAt).toLocaleString()}`,
        ...(a.url !== null && { href: a.url }),
      }))}
    />
  );
}

/** The item's history, newest first, paged with the query's cursor, and the comment box. */
function ActivityTab(props: { itemKey: string; itemId: string; canEdit: boolean }) {
  const t = useT();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [next, setNext] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  // A refetch of the newest page (an invalidation) moves the page boundaries: start again from
  // the top so no entry falls between an old cursor and the new first page.
  const firstLoads = useRef(0);
  const onFirst = useCallback((isEmpty: boolean) => {
    setEmpty(isEmpty);
    firstLoads.current += 1;
    if (firstLoads.current > 1) setCursors((c) => (c.length > 1 ? [undefined] : c));
  }, []);
  return (
    <Stack gap={16}>
      {props.canEdit && <CommentBox itemId={props.itemId} />}
      {empty ? (
        <Text tone="muted">{t(COPY.noActivity)}</Text>
      ) : (
        <ItemList
          label={t(COPY.activity)}
          hasMore={next !== null}
          onLoadMore={() => {
            if (next !== null) setCursors((c) => [...c, next]);
          }}
        >
          {cursors.map((before, i) => (
            <ActivityPage
              key={before ?? "first"}
              itemKey={props.itemKey}
              before={before}
              {...(i === cursors.length - 1 && { onNext: setNext })}
              {...(i === 0 && { onEmpty: onFirst })}
            />
          ))}
        </ItemList>
      )}
    </Stack>
  );
}

function ActivityPage(props: {
  itemKey: string;
  before: string | undefined;
  /** The last page reports the cursor of the page after it. */
  onNext?(next: string | null): void;
  /** The first page reports whether the history is empty. */
  onEmpty?(empty: boolean): void;
}) {
  const q = useCollabQuery("item.activity", {
    key: props.itemKey,
    ...(props.before !== undefined && { before: props.before }),
  });
  const data = q.data !== undefined && !isNotFound(q.data) ? q.data : undefined;
  const { onNext, onEmpty } = props;
  // two effects: a page that stops being the last one must not count as a new first-page read
  useEffect(() => {
    if (data !== undefined) onNext?.(data.next);
  }, [data, onNext]);
  useEffect(() => {
    if (data !== undefined) onEmpty?.(data.entries.length === 0);
  }, [data, onEmpty]);
  return data === undefined
    ? null
    : data.entries.map((e) => <ActivityItem key={e.id} entry={e} itemKey={props.itemKey} />);
}

const ACTIVITY_LABEL: Record<string, Copy> = {
  created: { zh: "创建了事项", en: "created the item" },
  updated: { zh: "修改了事项", en: "updated the item" },
  status_changed: { zh: "改变了状态", en: "changed the status" },
  assigned: { zh: "指派了事项", en: "assigned the item" },
  commented: { zh: "发表了评论", en: "commented" },
  linked: { zh: "关联了事项", en: "linked an item" },
  artifact_attached: { zh: "添加了产物", en: "attached an artifact" },
  gate_requested: { zh: "请求确认", en: "asked for a confirmation" },
  decision_asked: { zh: "提出了决策", en: "asked a decision" },
  decision_answered: { zh: "回答了决策", en: "answered a decision" },
  decision_canceled: { zh: "取消了决策", en: "canceled a decision" },
  decision_expired: { zh: "决策已过期", en: "a decision expired" },
  default_agent_dropped: {
    zh: "默认智能体不可用，已移除",
    en: "dropped an unusable default agent",
  },
  handoff_unresolved: { zh: "无法自动交接", en: "could not hand off" },
  agent_declined: { zh: "智能体拒绝了工作", en: "the agent declined the work" },
};

function ActivityItem({ entry, itemKey }: { entry: ActivityEntry; itemKey: string }) {
  const t = useT();
  const [full, setFull] = useState(false);
  const who =
    entry.actor.agent === null
      ? entry.actor.person.name
      : `${entry.actor.agent.name} (${entry.actor.person.name})`;
  const what = ACTIVITY_LABEL[entry.kind];
  const commentId = typeof entry.detail.commentId === "string" ? entry.detail.commentId : null;
  return (
    <ItemListItem
      title={`${who} ${t(what ?? COPY.changedItem)}`}
      meta={new Date(entry.at).toLocaleString()}
      {...(entry.clipped === true &&
        commentId !== null &&
        !full && {
          actions: (
            <Button variant="ghost" onClick={() => setFull(true)}>
              {t(COPY.showAll)}
            </Button>
          ),
        })}
    >
      {full && commentId !== null ? (
        <FullComment itemKey={itemKey} commentId={commentId} fallback={entry.comment ?? ""} />
      ) : (
        entry.comment !== undefined && <Markdown text={entry.comment} />
      )}
    </ItemListItem>
  );
}

/** A clipped comment in full (`item.comment`); the clipped text while it loads. */
function FullComment(props: { itemKey: string; commentId: string; fallback: string }) {
  const q = useCollabQuery("item.comment", { key: props.itemKey, commentId: props.commentId });
  const body = q.data !== undefined && !isNotFound(q.data) ? q.data.body : props.fallback;
  return <Markdown text={body} />;
}

function CommentBox({ itemId }: { itemId: string }) {
  const t = useT();
  const act = useCollabAction();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await act("item.comment", { itemId, body: body.trim() });
      if (r.toast === undefined) setBody("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap={8}>
      <Textarea
        aria-label={t(COPY.comment)}
        placeholder={t(COPY.comment)}
        value={body}
        rows={3}
        onChange={(e) => setBody(e.target.value)}
      />
      <Stack direction="row" justify="end">
        <Button
          variant="primary"
          disabled={body.trim() === ""}
          loading={busy}
          onClick={() => void post()}
        >
          {t(COPY.addComment)}
        </Button>
      </Stack>
      {error !== null && (
        <Text variant="small" tone="fail">
          {error}
        </Text>
      )}
    </Stack>
  );
}

function ConversationsTab({ itemKey }: { itemKey: string }) {
  const t = useT();
  const navigate = useNavigate();
  const q = useCollabQuery("item.conversations", { key: itemKey });
  const result = q.data !== undefined && !isNotFound(q.data) ? q.data : undefined;
  const rows = result?.conversations ?? [];
  if (q.status === "error") return <Text tone="fail">{t(COPY.loadFailed)}</Text>;
  return (
    <>
      <TruncatedNote truncated={result?.truncated} />
      <ItemList label={t(COPY.conversations)} empty={t(COPY.noConversations)}>
        {rows.length === 0
          ? null
          : rows.map((c) => (
              <ItemListItem
                key={c.id}
                title={`${c.agent.name} · ${c.owner.name}`}
                meta={new Date(c.lastActivityAt).toLocaleString()}
                actions={
                  <Button variant="ghost" onClick={() => navigate({ conversation: c.id })}>
                    {t(COPY.openConversation)}
                  </Button>
                }
              />
            ))}
      </ItemList>
    </>
  );
}
