import {
  Badge,
  Button,
  Icon,
  KeyValue,
  Spinner,
  Stack,
  Text,
  useAccess,
  useAction,
  useClientStorage,
  useLocale,
  usePrefersReducedMotion,
  useView,
} from "@capybara-hq/plugin-client";
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GraphEdge,
  GraphNode,
  MemoryDetail,
  MemoryNodesPage,
  MemoryPageData,
  MemorySearchHit,
} from "../page.js";
import {
  ALPHA_MIN,
  type Camera,
  draw,
  fitCamera,
  hitTest,
  layout,
  readPalette,
  type Sim,
  settle,
  step,
  TYPES,
  toWorld,
  zoomAt,
} from "./graph.js";
import {
  adminViewing,
  bytesOf,
  COPY,
  type Copy,
  canvasLabel,
  count,
  DELETE_CONFIRM,
  dateTime,
  loadingMore,
  relative,
  TYPE_LABEL,
  times,
} from "./i18n.js";

/**
 * The memory page (`org.page` "memory-page"): a top bar (agent, member for admins, search), the
 * directory neural tree on a canvas (or a list), and a side panel with the open memory.
 *
 * Data: the server view's `MemoryPageData`, then `more` until the cursor is null (nodes and edges
 * merged by id, so a page of data stays under the component data cap). The host replaces the
 * component's view with every action's view, so only data shaped like page data (with
 * `selection`) is adopted from `useView`; `open`, `search` and `more` answers are read from the
 * action result and never replace the page. Refusals come back as a toast the host shows.
 */

const BODY_MAX = 8192;
const DESC_MAX = 200;
/** Past this many memories the list is the default view (the graph gets hard to read). */
const LIST_DEFAULT_ABOVE = 300;
/** Pages of `more` one selection may fetch (1,000 memories fit in far fewer). */
const MAX_PAGES = 200;
const SEARCH_DEBOUNCE_MS = 300;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Page data (the view, `select`, `delete`), or null for anything else. */
export function asPageData(v: unknown): MemoryPageData | null {
  return isObject(v) &&
    Array.isArray(v.nodes) &&
    Array.isArray(v.edges) &&
    Array.isArray(v.agents) &&
    typeof v.canAdmin === "boolean" &&
    isObject(v.selection)
    ? (v as unknown as MemoryPageData)
    : null;
}

function asNodesPage(v: unknown): MemoryNodesPage | null {
  return isObject(v) && Array.isArray(v.nodes) && Array.isArray(v.edges) && !("selection" in v)
    ? (v as unknown as MemoryNodesPage)
    : null;
}

const asDetail = (v: unknown): MemoryDetail | null =>
  isObject(v) && isObject(v.detail) ? (v.detail as unknown as MemoryDetail) : null;

const asHits = (v: unknown): MemorySearchHit[] | null =>
  isObject(v) && Array.isArray(v.hits) ? (v.hits as unknown as MemorySearchHit[]) : null;

const edgeKey = (e: GraphEdge): string => `${e.kind}:${e.from}>${e.to}`;

function mergeNodes(a: GraphNode[], b: GraphNode[]): GraphNode[] {
  const byId = new Map(a.map((n) => [n.id, n]));
  for (const n of b) byId.set(n.id, n);
  return [...byId.values()];
}

function mergeEdges(a: GraphEdge[], b: GraphEdge[]): GraphEdge[] {
  const byKey = new Map(a.map((e) => [edgeKey(e), e]));
  for (const e of b) byKey.set(edgeKey(e), e);
  return [...byKey.values()];
}

/** What the page shows: the adopted page data plus the nodes and edges merged from `more`. */
interface Loaded {
  source: MemoryPageData;
  nodes: GraphNode[];
  edges: GraphEdge[];
  cursor: string | null;
  pages: number;
  gen: number;
}

const sameSelection = (a: MemoryPageData, b: MemoryPageData): boolean =>
  a.selection.agentId === b.selection.agentId && a.selection.accountId === b.selection.accountId;

/** The payload naming the selection (every action but `select` needs the agent). */
function selPayload(d: MemoryPageData): Record<string, string> {
  const out: Record<string, string> = { accountId: d.selection.accountId };
  if (d.selection.agentId !== null) out.agentId = d.selection.agentId;
  return out;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function MemoryPage() {
  const { view, status, retry } = useView();
  const action = useAction();
  const access = useAccess();
  const { locale, t } = useLocale();
  const reduced = usePrefersReducedMotion();
  const storage = useClientStorage();

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const genRef = useRef(0);
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null);
  const [mode, setMode] = useState<"graph" | "list" | null>(() => {
    const v = storage.get("view");
    return v === "graph" || v === "list" ? v : null;
  });
  const [fitSignal, setFitSignal] = useState(0);

  const adopt = useCallback((d: MemoryPageData, force: boolean) => {
    setLoaded((cur) => {
      if (cur !== null && cur.source === d) return cur;
      if (!force && cur !== null && !sameSelection(cur.source, d)) return cur;
      genRef.current += 1;
      return {
        source: d,
        nodes: d.nodes,
        edges: d.edges,
        cursor: d.cursor,
        pages: 1,
        gen: genRef.current,
      };
    });
  }, []);

  // `t` is a new function every render: read it through a ref so the callbacks stay stable
  const tRef = useRef(t);
  tRef.current = t;
  const fail = useCallback(
    (e: unknown) => setNotice(tRef.current(COPY.actionFailed) + messageOf(e)),
    [],
  );

  // the server view: adopt page data; anything else (another action's answer) is not the page
  const asked = useRef(false);
  const seenView = useRef<unknown>(undefined);
  useEffect(() => {
    if (seenView.current === view && view !== null) return;
    seenView.current = view;
    const d = asPageData(view?.data);
    if (d !== null) {
      adopt(d, false);
      return;
    }
    if (status === "ready" && loadedRef.current === null && !asked.current) {
      asked.current = true;
      action("select", { payload: {} })
        .then((r) => {
          const p = asPageData(r.view?.data);
          if (p !== null) adopt(p, true);
        })
        .catch(fail);
    }
  }, [view, status, adopt, action, fail]);

  // the rest of the nodes: `more` until the cursor is null
  const gen = loaded?.gen;
  const cursor = loaded?.cursor ?? null;
  useEffect(() => {
    const cur = loadedRef.current;
    if (cur === null || cursor === null || cur.gen !== gen) return;
    let live = true;
    const stop = () =>
      setLoaded((l) => (l !== null && l.gen === cur.gen ? { ...l, cursor: null } : l));
    action("more", { payload: { ...selPayload(cur.source), cursor } })
      .then((r) => {
        if (!live) return;
        const p = asNodesPage(r.view?.data);
        if (p === null) return stop();
        setLoaded((l) => {
          if (l === null || l.gen !== cur.gen) return l;
          const next = p.cursor === l.cursor || l.pages + 1 >= MAX_PAGES ? null : p.cursor;
          return {
            ...l,
            nodes: mergeNodes(l.nodes, p.nodes),
            edges: mergeEdges(l.edges, p.edges),
            cursor: next,
            pages: l.pages + 1,
          };
        });
      })
      .catch((e: unknown) => {
        if (!live) return;
        fail(e);
        stop();
      });
    return () => {
      live = false;
    };
  }, [gen, cursor, action, fail]);

  const data = loaded?.source ?? null;
  const editable = data?.editable ?? false;

  const openRef = useRef<string | null>(null);
  const closePanel = useCallback(() => {
    openRef.current = null;
    setOpenId(null);
    setDetail(null);
  }, []);

  const select = useCallback(
    async (payload: Record<string, string>) => {
      setBusy(true);
      setNotice(null);
      try {
        const r = await action("select", { payload });
        const p = asPageData(r.view?.data);
        if (p !== null) {
          adopt(p, true);
          closePanel();
          setHits(null);
          setQuery("");
          setFitSignal((n) => n + 1);
        }
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
    },
    [action, adopt, closePanel, fail],
  );

  const open = useCallback(
    async (memoryId: string) => {
      const cur = loadedRef.current;
      if (cur === null) return;
      openRef.current = memoryId;
      setOpenId(memoryId);
      setNotice(null);
      try {
        const r = await action("open", { payload: { ...selPayload(cur.source), memoryId } });
        if (openRef.current !== memoryId) return;
        const d = asDetail(r.view?.data);
        if (d === null) {
          // refused (the host shows the toast): nothing to show
          openRef.current = null;
          setOpenId(null);
          return;
        }
        setDetail(d);
      } catch (e) {
        fail(e);
      }
    },
    [action, fail],
  );

  const save = useCallback(
    async (memoryId: string, description: string, body: string): Promise<boolean> => {
      const cur = loadedRef.current;
      if (cur === null) return false;
      try {
        const r = await action("edit", {
          payload: { ...selPayload(cur.source), memoryId, description, body },
        });
        const d = asDetail(r.view?.data);
        if (d === null) return false;
        setDetail(d);
        setLoaded((l) =>
          l === null
            ? l
            : {
                ...l,
                nodes: l.nodes.map((n) =>
                  n.id === d.id ? { ...n, description: d.description } : n,
                ),
              },
        );
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [action, fail],
  );

  const remove = useCallback(
    async (memoryId: string) => {
      const cur = loadedRef.current;
      if (cur === null) return;
      try {
        const r = await action("delete", { payload: { ...selPayload(cur.source), memoryId } });
        const p = asPageData(r.view?.data);
        if (p === null) return;
        adopt(p, true);
        closePanel();
        setHits((h) => (h === null ? h : h.filter((x) => x.id !== memoryId)));
      } catch (e) {
        fail(e);
      }
    },
    [action, adopt, closePanel, fail],
  );

  // search: debounced while typing, at once on Enter
  const runSearch = useCallback(
    async (q: string) => {
      const cur = loadedRef.current;
      if (cur === null || cur.source.selection.agentId === null) return;
      if (q.trim() === "") {
        setHits(null);
        return;
      }
      try {
        const r = await action("search", { payload: { ...selPayload(cur.source), query: q } });
        const h = asHits(r.view?.data);
        if (h !== null) setHits(h);
      } catch (e) {
        fail(e);
      }
    },
    [action, fail],
  );
  useEffect(() => {
    if (query.trim() === "") {
      setHits(null);
      return;
    }
    const id = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, runSearch]);

  if (!access.atLeast("member")) {
    return <State icon="lock" title={t(COPY.noAccess)} />;
  }
  if (loaded === null || data === null) {
    if (status === "failed") {
      return (
        <State icon="circle-alert" title={t(COPY.failed)}>
          <Button onClick={retry}>{t(COPY.retry)}</Button>
        </State>
      );
    }
    return (
      <div className="cx-memory-state">
        <Spinner label={t(COPY.loading)} />
        <Text tone="muted">{t(COPY.loading)}</Text>
      </div>
    );
  }
  if (data.selection.agentId === null && data.agents.length === 0 && !data.canAdmin) {
    return <State icon="empty" title={t(COPY.emptyTitle)} body={t(COPY.emptyBody)} />;
  }

  const nodes = loaded.nodes;
  const shown: "graph" | "list" = mode ?? (data.total > LIST_DEFAULT_ABOVE ? "list" : "graph");
  const setShown = (m: "graph" | "list") => {
    setMode(m);
    storage.set("view", m);
  };
  const agentName = data.agents.find((a) => a.id === data.selection.agentId)?.name ?? "";
  const memberName =
    data.members?.find((m) => m.id === data.selection.accountId)?.name ?? data.selection.accountId;
  const highlight = hits === null ? null : new Set(hits.map((h) => h.id));
  const empty = nodes.length === 0;

  return (
    <div className="cx-memory-page" data-panel={openId !== null ? "open" : "closed"}>
      <form
        className="cx-memory-toolbar"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void runSearch(query);
        }}
      >
        <label className="cx-memory-field">
          <span className="cx-memory-field-label">{t(COPY.agent)}</span>
          <select
            className="cx-memory-select"
            value={data.selection.agentId ?? ""}
            disabled={busy || data.agents.length === 0}
            onChange={(e) =>
              void select({ agentId: e.target.value, accountId: data.selection.accountId })
            }
          >
            {data.selection.agentId === null ? <option value="">—</option> : null}
            {data.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {data.canAdmin && data.members !== undefined ? (
          <label className="cx-memory-field">
            <span className="cx-memory-field-label">{t(COPY.member)}</span>
            <select
              className="cx-memory-select"
              data-testid="memory-member-select"
              value={data.selection.accountId}
              disabled={busy}
              onChange={(e) => void select({ accountId: e.target.value })}
            >
              {data.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="cx-memory-search">
          <Icon name="search" size={14} />
          <input
            className="cx-memory-input"
            type="search"
            value={query}
            placeholder={t(COPY.search)}
            aria-label={t(COPY.search)}
            maxLength={500}
            disabled={data.selection.agentId === null}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
        </div>
        <div className="cx-memory-toolbar-end">
          <Text variant="small" tone="muted">
            {loaded.cursor !== null
              ? t(loadingMore(nodes.length, data.total))
              : t(count(Math.max(data.total, nodes.length)))}
          </Text>
          <fieldset className="cx-memory-toggle">
            <legend className="cx-memory-sr">{t(COPY.view)}</legend>
            <button
              type="button"
              className="cx-memory-toggle-item"
              aria-pressed={shown === "graph"}
              onClick={() => setShown("graph")}
            >
              {t(COPY.graph)}
            </button>
            <button
              type="button"
              className="cx-memory-toggle-item"
              aria-pressed={shown === "list"}
              onClick={() => setShown("list")}
            >
              {t(COPY.list)}
            </button>
          </fieldset>
          {shown === "graph" && !empty ? (
            <Button
              variant="ghost"
              title={t(COPY.fit)}
              aria-label={t(COPY.fit)}
              onClick={() => setFitSignal((n) => n + 1)}
            >
              <Icon name="maximize-2" size={14} />
            </Button>
          ) : null}
        </div>
      </form>

      {!editable ? (
        <div className="cx-memory-banner" role="note">
          <Icon name="admin" size={14} />
          <Text variant="small">{t(adminViewing(memberName))}</Text>
        </div>
      ) : null}
      {notice !== null ? (
        <div className="cx-memory-banner" data-tone="fail" role="alert">
          <Text variant="small" tone="fail">
            {notice}
          </Text>
        </div>
      ) : null}

      <div className="cx-memory-body">
        <div className="cx-memory-main">
          {hits !== null ? (
            <SearchResults hits={hits} onOpen={open} onClear={() => setQuery("")} />
          ) : null}
          {empty ? (
            <State
              icon="empty"
              title={t(COPY.emptyTitle)}
              body={t(
                data.selection.agentId === null
                  ? COPY.emptyBody
                  : editable
                    ? COPY.emptyAgent
                    : COPY.emptyOther,
              )}
            />
          ) : shown === "graph" ? (
            <GraphView
              nodes={nodes}
              edges={loaded.edges}
              agentLabel={agentName}
              motion={!reduced}
              selectedId={openId}
              highlight={highlight}
              fitSignal={fitSignal}
              onOpen={(id) => void open(id)}
              onEscape={closePanel}
              label={t(canvasLabel(nodes.length))}
            />
          ) : (
            <ListView
              nodes={nodes}
              highlight={highlight}
              selectedId={openId}
              onOpen={(id) => void open(id)}
            />
          )}
        </div>
        {openId !== null ? (
          <DetailPanel
            key={openId}
            detail={detail?.id === openId ? detail : null}
            editable={editable}
            canDelete={editable || data.canAdmin}
            locale={locale}
            onClose={closePanel}
            onOpen={(id) => void open(id)}
            onSave={save}
            onDelete={remove}
          />
        ) : null}
      </div>
    </div>
  );
}

function State(props: { icon: string; title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="cx-memory-state">
      <span className="cx-memory-state-icon" aria-hidden="true">
        <Icon name={props.icon} size={16} />
      </span>
      <Text variant="h3">{props.title}</Text>
      {props.body !== undefined ? <Text tone="muted">{props.body}</Text> : null}
      {props.children}
    </div>
  );
}

function TypeDot({ type }: { type: GraphNode["type"] }) {
  return <span className="cx-memory-dot" data-type={type} aria-hidden="true" />;
}

function Legend() {
  const { t } = useLocale();
  return (
    <div className="cx-memory-legend" aria-hidden="true">
      <div className="cx-memory-legend-row">
        {TYPES.map((type) => (
          <span key={type} className="cx-memory-legend-item">
            <TypeDot type={type} />
            {t(TYPE_LABEL[type])}
          </span>
        ))}
      </div>
      <div className="cx-memory-legend-row">
        <span className="cx-memory-legend-item">
          <span className="cx-memory-legend-line" data-kind="link" />
          {t(COPY.linkLegend)}
        </span>
        <span className="cx-memory-legend-item">
          <span className="cx-memory-legend-line" data-kind="semantic" />
          {t(COPY.semanticLegend)}
        </span>
      </div>
      <div className="cx-memory-legend-row">
        <span className="cx-memory-legend-item">{t(COPY.sizeLegend)}</span>
        <span className="cx-memory-legend-item">{t(COPY.glowLegend)}</span>
      </div>
    </div>
  );
}

interface GraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  agentLabel: string;
  motion: boolean;
  selectedId: string | null;
  highlight: ReadonlySet<string> | null;
  fitSignal: number;
  label: string;
  onOpen(id: string): void;
  onEscape(): void;
}

interface Tip {
  x: number;
  y: number;
  node: GraphNode;
}

/** The canvas: layout, simulation, drawing, pointer and keyboard. */
function GraphView(props: GraphViewProps) {
  const { locale, t } = useLocale();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Sim | null>(null);
  const camRef = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const hoverRef = useRef(-1);
  const focusRef = useRef(-1);
  /** The camera was moved by hand: stop fitting it automatically. */
  const movedRef = useRef(false);
  const dragRef = useRef<{
    node: number;
    sx: number;
    sy: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [tip, setTip] = useState<Tip | null>(null);
  const [focused, setFocused] = useState<GraphNode | null>(null);

  const paint = useCallback((time = 0) => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (canvas === null || sim === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const { w, h, dpr } = sizeRef.current;
    const p = propsRef.current;
    draw(ctx, sim, camRef.current, readPalette(canvas), {
      width: w,
      height: h,
      dpr,
      time,
      motion: p.motion,
      hover: hoverRef.current >= 0 ? hoverRef.current : focusRef.current,
      focus: focusRef.current,
      selectedId: p.selectedId,
      highlight: p.highlight,
    });
  }, []);

  const fit = useCallback(() => {
    const sim = simRef.current;
    const { w, h } = sizeRef.current;
    if (sim === null || w === 0 || h === 0) return;
    camRef.current = fitCamera(sim, w, h);
  }, []);

  // (re)build the layout when the data changes; nodes that stay keep their place
  const { nodes, edges, agentLabel, motion } = props;
  useEffect(() => {
    const previous = simRef.current;
    const sim = layout({ nodes, edges, agentLabel }, { now: Date.now(), previous });
    if (!motion) settle(sim);
    simRef.current = sim;
    hoverRef.current = -1;
    focusRef.current = -1;
    if (previous === null || !movedRef.current) fit();
    if (!motion) paint();
  }, [nodes, edges, agentLabel, motion, fit, paint]);

  // the fit button, and a new selection
  const { fitSignal } = props;
  useEffect(() => {
    if (fitSignal === 0) return;
    movedRef.current = false;
    fit();
    paint();
  }, [fitSignal, fit, paint]);

  // redraw when what is highlighted changes (reduced motion has no loop to pick it up)
  const { selectedId, highlight } = props;
  useEffect(() => {
    void selectedId;
    void highlight;
    if (!motion) paint();
  }, [selectedId, highlight, motion, paint]);

  // the canvas follows its box
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (wrap === null || canvas === null) return;
    const resize = () => {
      const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (!movedRef.current) fit();
      paint();
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fit, paint]);

  // motion: step until settled, ease the camera towards the fit meanwhile, keep pulsing
  useEffect(() => {
    if (!motion) return;
    let id = 0;
    const frame = (time: number) => {
      const sim = simRef.current;
      if (sim !== null && sim.alpha >= ALPHA_MIN) {
        step(sim);
        const { w, h } = sizeRef.current;
        if (!movedRef.current && w > 0 && h > 0) {
          const to = fitCamera(sim, w, h);
          const c = camRef.current;
          camRef.current = {
            x: c.x + (to.x - c.x) * 0.12,
            y: c.y + (to.y - c.y) * 0.12,
            k: c.k + (to.k - c.k) * 0.12,
          };
        }
      }
      paint(time);
      id = requestAnimationFrame(frame);
    };
    id = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(id);
  }, [motion, paint]);

  // wheel zoom (a non-passive listener, so the page does not scroll)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      movedRef.current = true;
      camRef.current = zoomAt(
        camRef.current,
        e.clientX - rect.left,
        e.clientY - rect.top,
        Math.exp(-e.deltaY * 0.0015),
      );
      if (!propsRef.current.motion) paint();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [paint]);

  const local = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (sim === null) return;
    const { sx, sy } = local(e);
    const w = toWorld(camRef.current, sx, sy);
    const node = hitTest(sim, w.x, w.y, 4 / camRef.current.k);
    dragRef.current = { node, sx, sy, lastX: sx, lastY: sy, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (sim === null) return;
    const { sx, sy } = local(e);
    const drag = dragRef.current;
    const motionOn = propsRef.current.motion;
    if (drag !== null) {
      if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 4) return;
      drag.moved = true;
      setTip(null);
      const n = drag.node >= 0 ? sim.nodes[drag.node] : undefined;
      if (n !== undefined && n.kind !== "agent") {
        const w = toWorld(camRef.current, sx, sy);
        n.x = w.x;
        n.y = w.y;
        n.pinned = true;
        if (motionOn) sim.alpha = Math.max(sim.alpha, 0.25);
      } else {
        movedRef.current = true;
        const c = camRef.current;
        camRef.current = { ...c, x: c.x + sx - drag.lastX, y: c.y + sy - drag.lastY };
      }
      drag.lastX = sx;
      drag.lastY = sy;
      if (!motionOn) paint();
      return;
    }
    const w = toWorld(camRef.current, sx, sy);
    const i = hitTest(sim, w.x, w.y, 4 / camRef.current.k);
    if (i !== hoverRef.current) {
      hoverRef.current = i;
      const memory = i >= 0 ? (sim.nodes[i]?.memory ?? null) : null;
      setTip(memory === null ? null : { x: sx, y: sy, node: memory });
      if (!motionOn) paint();
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const sim = simRef.current;
    if (drag === null || sim === null) return;
    const n = drag.node >= 0 ? sim.nodes[drag.node] : undefined;
    if (drag.moved) {
      // a dragged node stays where it was dropped only under reduced motion; otherwise it drifts back in
      if (n !== undefined && n.kind !== "agent" && propsRef.current.motion) n.pinned = false;
      return;
    }
    void e;
    if (n?.memory) propsRef.current.onOpen(n.memory.id);
  };

  const onPointerLeave = () => {
    if (dragRef.current !== null) return;
    hoverRef.current = -1;
    setTip(null);
    if (!propsRef.current.motion) paint();
  };

  // keyboard: step through the memories in path order, Enter opens, Escape closes the panel
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (sim === null) return;
    const order = sim.nodes.flatMap((n, i) => (n.kind === "memory" ? [i] : []));
    if (order.length === 0) return;
    const at = order.indexOf(focusRef.current);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown")
      next = order[(at + 1) % order.length] ?? -1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = order[(at - 1 + order.length) % order.length] ?? -1;
    else if (e.key === "Home") next = order[0] ?? -1;
    else if (e.key === "End") next = order[order.length - 1] ?? -1;
    else if (e.key === "Enter" || e.key === " ") {
      const memory = sim.nodes[focusRef.current]?.memory;
      if (memory) {
        e.preventDefault();
        propsRef.current.onOpen(memory.id);
      }
      return;
    } else if (e.key === "Escape") {
      propsRef.current.onEscape();
      return;
    } else return;
    e.preventDefault();
    focusRef.current = next;
    const n = sim.nodes[next];
    setFocused(n?.memory ?? null);
    if (n !== undefined) {
      // keep the focused node on screen
      const { w, h } = sizeRef.current;
      const c = camRef.current;
      const sx = n.x * c.k + c.x;
      const sy = n.y * c.k + c.y;
      if (w > 0 && (sx < 40 || sy < 40 || sx > w - 40 || sy > h - 40)) {
        movedRef.current = true;
        camRef.current = { ...c, x: w / 2 - n.x * c.k, y: h / 2 - n.y * c.k };
      }
    }
    if (!propsRef.current.motion) paint();
  };

  return (
    <div className="cx-memory-stage" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="cx-memory-canvas"
        tabIndex={0}
        aria-label={props.label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        onBlur={() => {
          focusRef.current = -1;
          setFocused(null);
          if (!propsRef.current.motion) paint();
        }}
      />
      <div className="cx-memory-sr cx-memory-live" aria-live="polite">
        {focused !== null ? `${focused.path} — ${focused.description}` : ""}
      </div>
      {tip !== null ? (
        <div
          className="cx-memory-tip"
          style={{ left: tip.x + 14, top: tip.y + 14 }}
          aria-hidden="true"
        >
          <span className="cx-memory-tip-path">
            <TypeDot type={tip.node.type} />
            {tip.node.path}
          </span>
          <span className="cx-memory-tip-desc">{tip.node.description}</span>
          <span className="cx-memory-tip-meta">
            {t(COPY.recalled)} {t(times(tip.node.recalls))} · {t(COPY.lastRecalled)}{" "}
            {relative(tip.node.lastRecalledAt, locale)}
          </span>
        </div>
      ) : null}
      <Legend />
      <div className="cx-memory-hint" aria-hidden="true">
        {t(COPY.hint)}
      </div>
    </div>
  );
}

/** The list view: every memory by path, grouped by type; a row opens the memory. */
function ListView(props: {
  nodes: GraphNode[];
  highlight: ReadonlySet<string> | null;
  selectedId: string | null;
  onOpen(id: string): void;
}) {
  const { locale, t } = useLocale();
  const sorted = useMemo(
    () => [...props.nodes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    [props.nodes],
  );
  const rows = props.highlight === null ? sorted : sorted.filter((n) => props.highlight?.has(n.id));
  return (
    <div className="cx-memory-list">
      <div className="cx-memory-list-head" aria-hidden="true">
        <span>{t(COPY.path)}</span>
        <span>{t(COPY.description)}</span>
        <span>{t(COPY.recalled)}</span>
        <span>{t(COPY.lastRecalled)}</span>
      </div>
      <ul className="cx-memory-rows">
        {rows.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              className="cx-memory-row"
              data-memory-id={n.id}
              aria-current={n.id === props.selectedId ? "true" : undefined}
              onClick={() => props.onOpen(n.id)}
            >
              <span className="cx-memory-row-path">
                <TypeDot type={n.type} />
                {n.path}
              </span>
              <span className="cx-memory-row-desc">{n.description}</span>
              <span className="cx-memory-row-num">{n.recalls}</span>
              <span className="cx-memory-row-num">{relative(n.lastRecalledAt, locale)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SearchResults(props: {
  hits: MemorySearchHit[];
  onOpen(id: string): void;
  onClear(): void;
}) {
  const { t } = useLocale();
  return (
    <section className="cx-memory-hits" aria-label={t(COPY.search)}>
      <div className="cx-memory-hits-head">
        <Text variant="small" tone="muted">
          {props.hits.length === 0 ? t(COPY.noHits) : t(count(props.hits.length))}
        </Text>
        <Button variant="ghost" onClick={props.onClear}>
          {t(COPY.clearSearch)}
        </Button>
      </div>
      {props.hits.map((h) => (
        <button
          type="button"
          key={h.id}
          className="cx-memory-hit"
          onClick={() => props.onOpen(h.id)}
        >
          <span className="cx-memory-hit-path">{h.path}</span>
          <span className="cx-memory-hit-desc">{h.description}</span>
          {h.snippet !== "" ? <span className="cx-memory-hit-snippet">{h.snippet}</span> : null}
        </button>
      ))}
    </section>
  );
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** The open memory: its fields, links, edit (own memories) and delete with the confirmation. */
function DetailPanel(props: {
  detail: MemoryDetail | null;
  editable: boolean;
  canDelete: boolean;
  locale: "zh" | "en";
  onClose(): void;
  onOpen(id: string): void;
  onSave(id: string, description: string, body: string): Promise<boolean>;
  onDelete(id: string): Promise<void>;
}) {
  const { t } = useLocale();
  const { detail, locale } = props;
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);

  if (detail === null) {
    return (
      <aside className="cx-memory-panel" aria-busy="true">
        <div className="cx-memory-panel-head">
          <Spinner size={12} />
          <span className="cx-memory-grow" />
          <Button variant="ghost" aria-label={t(COPY.close)} onClick={props.onClose}>
            <Icon name="x" size={14} />
          </Button>
        </div>
      </aside>
    );
  }
  const L = (c: Copy) => c[locale];
  const bodyBytes = utf8Bytes(body);
  const invalid =
    description.trim() === "" ||
    description.length > DESC_MAX ||
    /[\r\n]/.test(description) ||
    bodyBytes > BODY_MAX;

  return (
    <aside className="cx-memory-panel" aria-label={detail.path}>
      <div className="cx-memory-panel-head">
        <TypeDot type={detail.type} />
        <span className="cx-memory-panel-path">{detail.path}</span>
        <Badge>{L(TYPE_LABEL[detail.type])}</Badge>
        <span className="cx-memory-grow" />
        <Button variant="ghost" aria-label={t(COPY.close)} onClick={props.onClose}>
          <Icon name="x" size={14} />
        </Button>
      </div>
      <div className="cx-memory-panel-body">
        {mode === "edit" ? (
          <form
            className="cx-memory-edit"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (invalid) return;
              setPending(true);
              void props.onSave(detail.id, description, body).then((ok) => {
                setPending(false);
                if (ok) setMode("view");
              });
            }}
          >
            <label className="cx-memory-field" data-block="true">
              <span className="cx-memory-field-label">{t(COPY.description)}</span>
              <input
                className="cx-memory-input"
                value={description}
                maxLength={DESC_MAX}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="cx-memory-field" data-block="true">
              <span className="cx-memory-field-label">{t(COPY.body)}</span>
              <textarea
                className="cx-memory-textarea"
                value={body}
                rows={12}
                onChange={(e) => setBody(e.target.value)}
              />
              <span className="cx-memory-field-note" data-over={bodyBytes > BODY_MAX}>
                {t(bytesOf(bodyBytes, BODY_MAX))}
              </span>
            </label>
            <Stack direction="row" gap={8} justify="end">
              <Button onClick={() => setMode("view")}>{t(COPY.cancel)}</Button>
              <Button type="submit" variant="primary" loading={pending} disabled={invalid}>
                {t(COPY.save)}
              </Button>
            </Stack>
          </form>
        ) : (
          <>
            <Text>{detail.description}</Text>
            <div className="cx-memory-markdown">{detail.body}</div>
            {detail.links.length > 0 ? (
              <div className="cx-memory-links">
                <Text variant="small" tone="muted">
                  {t(COPY.links)}
                </Text>
                {detail.links.map((l) =>
                  l.targetId !== null ? (
                    <button
                      type="button"
                      key={l.path}
                      className="cx-memory-link"
                      onClick={() => props.onOpen(l.targetId as string)}
                    >
                      [[{l.path}]]
                    </button>
                  ) : (
                    <span key={l.path} className="cx-memory-link" data-dangling="true">
                      [[{l.path}]] · {t(COPY.dangling)}
                    </span>
                  ),
                )}
              </div>
            ) : null}
            <KeyValue
              keyWidth="12ch"
              rows={[
                { k: t(COPY.recalled), v: t(times(detail.recalls)) },
                { k: t(COPY.lastRecalled), v: relative(detail.lastRecalledAt, locale) },
                { k: t(COPY.created), v: dateTime(detail.createdAt, locale) },
                { k: t(COPY.updated), v: dateTime(detail.updatedAt, locale) },
                ...(detail.createdIn !== null
                  ? [
                      {
                        k: t(COPY.createdIn),
                        v: props.editable ? (
                          <a
                            className="cx-memory-anchor"
                            href={`/chat/${encodeURIComponent(detail.createdIn)}`}
                          >
                            {t(COPY.openConversation)}
                          </a>
                        ) : (
                          detail.createdIn
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            {mode === "confirm" ? (
              <div
                className="cx-memory-confirm"
                role="alertdialog"
                aria-label={t(COPY.confirmTitle)}
              >
                <Text variant="h3">{t(COPY.confirmTitle)}</Text>
                <Text variant="small">{t(DELETE_CONFIRM)}</Text>
                <Stack direction="row" gap={8} justify="end">
                  <Button onClick={() => setMode("view")}>{t(COPY.cancel)}</Button>
                  <Button
                    variant="danger-solid"
                    loading={pending}
                    onClick={() => {
                      setPending(true);
                      void props.onDelete(detail.id).finally(() => setPending(false));
                    }}
                  >
                    {t(COPY.delete)}
                  </Button>
                </Stack>
              </div>
            ) : (
              <Stack direction="row" gap={8} justify="end">
                {props.editable ? (
                  <Button
                    onClick={() => {
                      setDescription(detail.description);
                      setBody(detail.body);
                      setMode("edit");
                    }}
                  >
                    {t(COPY.edit)}
                  </Button>
                ) : null}
                {props.canDelete ? (
                  <Button variant="danger" onClick={() => setMode("confirm")}>
                    {t(COPY.delete)}
                  </Button>
                ) : null}
              </Stack>
            )}
            {!props.editable ? (
              <Text variant="small" tone="muted">
                {t(COPY.readOnly)}
              </Text>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
