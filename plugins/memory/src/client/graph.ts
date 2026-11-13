import type { GraphEdge, GraphNode } from "../page.js";

/**
 * The directory neural tree of the memory page, framework-free: the layout (the agent at the
 * centre, a node per directory chained to its parent, memories as leaves of their directory), a
 * small force simulation that refines it, hit testing, the camera and the canvas drawing.
 *
 * Encoding (spec §5.5): size = recall count, brightness = how recently it was recalled, colour =
 * type (theme tokens read from CSS at draw time, never colour literals here); solid edges are the
 * `[[links]]` the model wrote, faint dashed edges semantic neighbours.
 */

export type MemoryType = GraphNode["type"];

/** The four type directories, always drawn, in this order around the agent. */
export const TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export const AGENT_ID = "agent";
export const dirId = (path: string): string => `dir:${path}`;

/** Below this the simulation is settled and stops stepping. */
export const ALPHA_MIN = 0.005;

const DAY_MS = 86_400_000;
const AGENT_R = 13;
const DIR_R = 4.5;

export interface SimNode {
  id: string;
  kind: "agent" | "dir" | "memory";
  /** Directory segment, memory file name without `.md`, or the agent's name. */
  label: string;
  /** Directory path (`project/github`) or memory path; "" for the agent. */
  path: string;
  /** Type of a memory or of the type directory it hangs under; null for the agent. */
  type: MemoryType | null;
  /** Index of the tree parent, -1 for the agent. */
  parent: number;
  depth: number;
  /** Distance from the centre the node is held at (its ring). */
  ring: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Held where it is (the agent, a node being dragged). */
  pinned: boolean;
  r: number;
  /** 0.25..1, from the last recall. */
  brightness: number;
  /** Recalled within the last week: pulses when motion is allowed. */
  recent: boolean;
  /** Deterministic 0..1 per node, for drift and pulse phases. */
  phase: number;
  memory: GraphNode | null;
}

export interface SimEdge {
  a: number;
  b: number;
  kind: "tree" | "link" | "semantic";
  phase: number;
}

export interface Sim {
  nodes: SimNode[];
  edges: SimEdge[];
  index: Map<string, number>;
  /** Neighbours of each node over every edge kind (hover highlight). */
  adjacency: Set<number>[];
  /** Simulation heat: 1 when built, decays towards 0; below ALPHA_MIN it no longer steps. */
  alpha: number;
}

/** Node radius from the recall count: 4 + 1.2·√recalls, at most 18. */
export function radiusOf(recalls: number): number {
  return Math.min(18, 4 + 1.2 * Math.sqrt(Math.max(0, recalls)));
}

/** Brightness from the last recall: max(0.25, e^(-ageDays/30)); never recalled = 0.25. */
export function brightnessOf(lastRecalledAt: string | null, now: number): number {
  if (lastRecalledAt === null) return 0.25;
  const at = Date.parse(lastRecalledAt);
  if (Number.isNaN(at)) return 0.25;
  const ageDays = Math.max(0, (now - at) / DAY_MS);
  return Math.max(0.25, Math.exp(-ageDays / 30));
}

/** FNV-1a of a string mapped to 0..1 (stable jitter and phases, so layouts repeat). */
export function unit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

/** Ring radius of a directory at `depth` (1 = a type directory). */
const dirRing = (depth: number): number => (depth <= 0 ? 0 : 120 + (depth - 1) * 80);

export interface LayoutInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Label of the centre node (the agent's name). */
  agentLabel: string;
}

export interface LayoutOptions {
  now: number;
  /** The simulation this one replaces: nodes that stay keep their positions. */
  previous?: Sim | null;
}

/**
 * Builds the tree (agent, the four type directories, deeper directories, memories in path order),
 * the cross edges, and a radial starting layout: each subtree gets an angular sector proportional to
 * its memories, directories sit on rings, leaves just outside their directory's ring.
 */
export function layout(input: LayoutInput, opts: LayoutOptions): Sim {
  const nodes: SimNode[] = [];
  const index = new Map<string, number>();
  const children: number[][] = [];
  const add = (n: Omit<SimNode, "x" | "y" | "vx" | "vy" | "ring">): number => {
    const i = nodes.length;
    nodes.push({ ...n, x: 0, y: 0, vx: 0, vy: 0, ring: 0 });
    index.set(n.id, i);
    children.push([]);
    if (n.parent >= 0) children[n.parent]?.push(i);
    return i;
  };
  add({
    id: AGENT_ID,
    kind: "agent",
    label: input.agentLabel,
    path: "",
    type: null,
    parent: -1,
    depth: 0,
    pinned: true,
    r: AGENT_R,
    brightness: 1,
    recent: false,
    phase: 0,
    memory: null,
  });
  const dir = (path: string): number => {
    const found = index.get(dirId(path));
    if (found !== undefined) return found;
    const slash = path.lastIndexOf("/");
    const parent = slash === -1 ? 0 : dir(path.slice(0, slash));
    const first = path.split("/")[0] as MemoryType;
    return add({
      id: dirId(path),
      kind: "dir",
      label: path.slice(slash + 1),
      path,
      type: TYPES.includes(first) ? first : null,
      parent,
      depth: path.split("/").length,
      pinned: false,
      r: DIR_R,
      brightness: 1,
      recent: false,
      phase: unit(path),
      memory: null,
    });
  };
  for (const t of TYPES) dir(t);
  const memories = [...input.nodes].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const m of memories) {
    if (index.has(m.id)) continue;
    const parent = m.dir === "" ? 0 : dir(m.dir);
    const name = m.path.slice(m.path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const brightness = brightnessOf(m.lastRecalledAt, opts.now);
    const last = m.lastRecalledAt === null ? Number.NaN : Date.parse(m.lastRecalledAt);
    add({
      id: m.id,
      kind: "memory",
      label: name,
      path: m.path,
      type: m.type,
      parent,
      depth: (nodes[parent]?.depth ?? 0) + 1,
      pinned: false,
      r: radiusOf(m.recalls),
      brightness,
      recent: !Number.isNaN(last) && opts.now - last < 7 * DAY_MS,
      phase: unit(m.id),
      memory: m,
    });
  }

  const edges: SimEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i] as SimNode;
    edges.push({ a: n.parent, b: i, kind: "tree", phase: n.phase });
  }
  const seen = new Set<string>();
  for (const e of input.edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = e.kind === "semantic" ? `s${Math.min(a, b)}~${Math.max(a, b)}` : `l${a}>${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ a, b, kind: e.kind, phase: unit(key) });
  }
  const adjacency = nodes.map(() => new Set<number>());
  for (const e of edges) {
    adjacency[e.a]?.add(e.b);
    adjacency[e.b]?.add(e.a);
  }

  // the radial start: sectors by weight (memories below a node, at least 1)
  const weight = new Array<number>(nodes.length).fill(0);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const own = nodes[i]?.kind === "memory" ? 1 : 0;
    const sum = (children[i] ?? []).reduce((s, c) => s + (weight[c] ?? 0), 0);
    weight[i] = Math.max(1, own + sum);
  }
  const place = (i: number, from: number, to: number): void => {
    const n = nodes[i] as SimNode;
    const kids = children[i] ?? [];
    let at = from;
    const total = kids.reduce((s, c) => s + (weight[c] ?? 1), 0);
    kids.forEach((c, k) => {
      const span = ((to - from) * (weight[c] ?? 1)) / Math.max(1, total);
      const child = nodes[c] as SimNode;
      const angle = at + span / 2 + (child.phase - 0.5) * span * 0.3;
      child.ring =
        child.kind === "dir"
          ? dirRing(child.depth)
          : (n.kind === "agent" ? 70 : n.ring) + 46 + (k % 3) * 20 + child.r;
      child.x = Math.cos(angle) * child.ring;
      child.y = Math.sin(angle) * child.ring;
      place(c, at, at + span);
      at += span;
    });
  };
  place(0, -Math.PI / 2, (3 * Math.PI) / 2);

  const prev = opts.previous ?? null;
  if (prev !== null) {
    for (const n of nodes) {
      const j = prev.index.get(n.id);
      const old = j === undefined ? undefined : prev.nodes[j];
      if (old === undefined) continue;
      n.x = old.x;
      n.y = old.y;
    }
  }
  return { nodes, edges, index, adjacency, alpha: prev === null ? 1 : 0.4 };
}

/** One tick of the forces (repulsion and collision on a grid, tree springs, ring pull, link pull). */
export function step(sim: Sim): number {
  const { nodes } = sim;
  const alpha = sim.alpha;
  const CELL = 110;
  const grid = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
    const list = grid.get(key);
    if (list === undefined) grid.set(key, [i]);
    else list.push(i);
  });
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i] as SimNode;
    const gx = Math.floor(a.x / CELL);
    const gy = Math.floor(a.y / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (const j of grid.get(`${gx + ox},${gy + oy}`) ?? []) {
          if (j <= i) continue;
          const b = nodes[j] as SimNode;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 === 0) {
            dx = (a.phase - b.phase) * 0.1 + 0.01;
            dy = 0.01;
            d2 = dx * dx + dy * dy;
          }
          if (d2 > CELL * CELL) continue;
          const d = Math.sqrt(d2);
          // a 1/d charge, plus a collision push when the circles (with a gap) overlap
          let f = (60 * alpha) / d;
          const min = a.r + b.r + 6;
          if (d < min) f += (min - d) * 0.5;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }
    }
  }
  for (const e of sim.edges) {
    if (e.kind === "semantic") continue;
    const a = nodes[e.a] as SimNode;
    const b = nodes[e.b] as SimNode;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const rest = e.kind === "tree" ? Math.max(30, b.ring - a.ring) : 90;
    const k = ((d - rest) / d) * alpha * (e.kind === "tree" ? 0.12 : 0.015);
    a.vx += dx * k * 0.5;
    a.vy += dy * k * 0.5;
    b.vx -= dx * k * 0.5;
    b.vy -= dy * k * 0.5;
  }
  for (const n of nodes) {
    if (n.kind === "agent") continue;
    const d = Math.sqrt(n.x * n.x + n.y * n.y) || 1;
    const k = ((n.ring - d) / d) * 0.08 * alpha;
    n.vx += n.x * k;
    n.vy += n.y * k;
  }
  for (const n of nodes) {
    if (n.pinned) {
      n.vx = 0;
      n.vy = 0;
      if (n.kind === "agent") {
        n.x = 0;
        n.y = 0;
      }
      continue;
    }
    n.vx *= 0.6;
    n.vy *= 0.6;
    n.x += n.vx;
    n.y += n.vy;
  }
  sim.alpha += (0 - sim.alpha) * 0.03;
  return sim.alpha;
}

/** Steps until settled (reduced motion: the layout settles once, then stays). */
export function settle(sim: Sim, maxTicks = 240): void {
  for (let t = 0; t < maxTicks && sim.alpha >= ALPHA_MIN; t++) step(sim);
  sim.alpha = 0;
}

/** The topmost node under a world point (with `slop` world units of grace), or -1. */
export function hitTest(sim: Sim, x: number, y: number, slop = 3): number {
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = sim.nodes.length - 1; i >= 0; i--) {
    const n = sim.nodes[i] as SimNode;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= n.r + slop && d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** Screen = world · k + (x, y). */
export interface Camera {
  x: number;
  y: number;
  k: number;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 4;

export const toWorld = (cam: Camera, sx: number, sy: number): { x: number; y: number } => ({
  x: (sx - cam.x) / cam.k,
  y: (sy - cam.y) / cam.k,
});

/** The camera that shows every node in a `w` × `h` viewport. */
export function fitCamera(sim: Sim, w: number, h: number, pad = 48): Camera {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of sim.nodes) {
    minX = Math.min(minX, n.x - n.r);
    minY = Math.min(minY, n.y - n.r);
    maxX = Math.max(maxX, n.x + n.r);
    maxY = Math.max(maxY, n.y + n.r);
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const k = Math.min(1.6, Math.max(MIN_ZOOM, Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh)));
  return { k, x: w / 2 - ((minX + maxX) / 2) * k, y: h / 2 - ((minY + maxY) / 2) * k };
}

/** Zooms by `factor` around the screen point (sx, sy). */
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.k * factor));
  const w = toWorld(cam, sx, sy);
  return { k, x: sx - w.x * k, y: sy - w.y * k };
}

/** The colours and font the canvas draws with, read from CSS custom properties. */
export interface Palette {
  type: Record<MemoryType, string>;
  agent: string;
  ink: string;
  muted: string;
  faint: string;
  bg: string;
  font: string;
}

/**
 * Reads the palette from the element's computed style: the plugin's `--cx-memory-type-*` tokens
 * (its stylesheet maps them to theme tokens, so a theme can restyle them), else the theme tokens
 * themselves, else CSS system colours.
 */
export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string =>
    cs.getPropertyValue(name).trim() || fallback;
  const ink = v("--cb-ink", "CanvasText");
  const accent = v("--cb-accent", ink);
  return {
    type: {
      user: v("--cx-memory-type-user", accent),
      feedback: v("--cx-memory-type-feedback", v("--cb-warn", ink)),
      project: v("--cx-memory-type-project", v("--cb-ok", ink)),
      reference: v("--cx-memory-type-reference", ink),
    },
    agent: v("--cx-memory-agent", accent),
    ink,
    muted: v("--cb-muted", "GrayText"),
    faint: v("--cb-faint", "GrayText"),
    bg: v("--cb-bg", "Canvas"),
    font: v("--cb-font", "monospace"),
  };
}

export interface DrawState {
  width: number;
  height: number;
  dpr: number;
  /** Milliseconds; only read when `motion` is on. */
  time: number;
  /** Drift and pulses (off under reduced motion). */
  motion: boolean;
  /** Hovered or keyboard-focused node index, or -1: it and its neighbours stay lit. */
  hover: number;
  /** Keyboard focus ring, or -1. */
  focus: number;
  /** The memory open in the side panel, or null. */
  selectedId: string | null;
  /** Search hits: when set, everything else dims. */
  highlight: ReadonlySet<string> | null;
}

/** Quadratic control point of a tree edge: the parent's ring along the child's angle (a dendrogram curve). */
function control(p: SimNode, c: SimNode): { x: number; y: number } {
  const pr = Math.hypot(p.x, p.y);
  const ca = Math.atan2(c.y, c.x);
  if (pr < 1) return { x: (p.x + c.x) / 2, y: (p.y + c.y) / 2 };
  return { x: Math.cos(ca) * pr, y: Math.sin(ca) * pr };
}

function bezier(
  a: { x: number; y: number },
  c: { x: number; y: number },
  b: { x: number; y: number },
  t: number,
) {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

const colourOf = (pal: Palette, n: SimNode): string =>
  n.kind === "agent" ? pal.agent : n.type === null ? pal.muted : pal.type[n.type];

/** Draws one frame. */
export function draw(
  ctx: CanvasRenderingContext2D,
  sim: Sim,
  cam: Camera,
  pal: Palette,
  st: DrawState,
): void {
  const { nodes } = sim;
  const k = cam.k;
  ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
  ctx.clearRect(0, 0, st.width, st.height);
  ctx.translate(cam.x, cam.y);
  ctx.scale(k, k);

  const lit = new Set<number>();
  if (st.hover >= 0) {
    lit.add(st.hover);
    for (const j of sim.adjacency[st.hover] ?? []) lit.add(j);
  }
  const hit = (n: SimNode): boolean => st.highlight === null || st.highlight.has(n.id);
  const dimOf = (i: number): number => {
    const n = nodes[i] as SimNode;
    if (lit.size > 0) return lit.has(i) ? 1 : 0.15;
    if (st.highlight !== null) return n.kind !== "memory" || hit(n) ? 1 : 0.15;
    return 1;
  };
  const drift = (n: SimNode): { x: number; y: number } => {
    if (!st.motion || n.kind !== "memory") return { x: n.x, y: n.y };
    const p = n.phase * Math.PI * 2;
    return {
      x: n.x + Math.sin(st.time / 1700 + p) * 1.4,
      y: n.y + Math.cos(st.time / 2100 + p) * 1.4,
    };
  };
  const pos = nodes.map(drift);
  const px = 1 / k;

  // semantic neighbours: faint dashes
  ctx.setLineDash([3 * px, 4 * px]);
  ctx.lineWidth = px;
  ctx.strokeStyle = pal.muted;
  for (const e of sim.edges) {
    if (e.kind !== "semantic") continue;
    const a = pos[e.a] as { x: number; y: number };
    const b = pos[e.b] as { x: number; y: number };
    ctx.globalAlpha = 0.28 * Math.min(dimOf(e.a), dimOf(e.b));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // the tree: dendrogram curves in the colour of the branch
  for (const e of sim.edges) {
    if (e.kind !== "tree") continue;
    const p = nodes[e.a] as SimNode;
    const c = nodes[e.b] as SimNode;
    const a = pos[e.a] as { x: number; y: number };
    const b = pos[e.b] as { x: number; y: number };
    const cp = control(p, c);
    ctx.globalAlpha =
      (c.kind === "dir" ? 0.45 : 0.22 + 0.25 * c.brightness) * Math.min(dimOf(e.a), dimOf(e.b));
    ctx.strokeStyle = colourOf(pal, c);
    ctx.lineWidth = (c.kind === "dir" ? 1.4 : 1) * px;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cp.x, cp.y, b.x, b.y);
    ctx.stroke();
  }

  // links the model wrote: solid
  ctx.strokeStyle = pal.ink;
  ctx.lineWidth = 1.2 * px;
  for (const e of sim.edges) {
    if (e.kind !== "link") continue;
    const a = pos[e.a] as { x: number; y: number };
    const b = pos[e.b] as { x: number; y: number };
    ctx.globalAlpha = 0.5 * Math.min(dimOf(e.a), dimOf(e.b));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // pulses: a spark along each link, and from each recently recalled memory's directory to it
  if (st.motion) {
    for (const e of sim.edges) {
      const c = nodes[e.b] as SimNode;
      if (e.kind === "semantic" || (e.kind === "tree" && !c.recent)) continue;
      const t = (st.time / (e.kind === "link" ? 3200 : 2600) + e.phase) % 1;
      const a = pos[e.a] as { x: number; y: number };
      const b = pos[e.b] as { x: number; y: number };
      const at =
        e.kind === "tree"
          ? bezier(a, control(nodes[e.a] as SimNode, c), b, t)
          : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      ctx.globalAlpha = Math.sin(Math.PI * t) * 0.9 * Math.min(dimOf(e.a), dimOf(e.b));
      ctx.fillStyle = e.kind === "link" ? pal.ink : colourOf(pal, c);
      ctx.beginPath();
      ctx.arc(at.x, at.y, 1.8 * px, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // nodes
  nodes.forEach((n, i) => {
    const p = pos[i] as { x: number; y: number };
    const dim = dimOf(i);
    const colour = colourOf(pal, n);
    if (n.kind === "dir") {
      ctx.globalAlpha = dim;
      ctx.fillStyle = pal.bg;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.4 * px;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      return;
    }
    if (n.kind === "agent") {
      const breathe = st.motion ? Math.sin(st.time / 900) * 2 : 0;
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.12 * dim;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.r * 2.4 + breathe, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.35 * dim;
      ctx.strokeStyle = colour;
      ctx.lineWidth = px;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.r + 6 + breathe / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = dim;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // a memory: glow, pulse ring, body
    if (n.brightness > 0.4) {
      ctx.globalAlpha = 0.14 * n.brightness * dim;
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.r * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (st.motion && n.recent) {
      const t = (st.time / 2400 + n.phase) % 1;
      ctx.globalAlpha = (1 - t) * 0.5 * dim;
      ctx.strokeStyle = colour;
      ctx.lineWidth = px;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.r + 2 + t * 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = (0.3 + 0.7 * n.brightness) * dim;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(p.x, p.y, n.r, 0, Math.PI * 2);
    ctx.fill();
    if (st.highlight?.has(n.id) === true) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (n.id === st.selectedId) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.r + 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  if (st.focus >= 0) {
    const n = nodes[st.focus];
    const p = pos[st.focus];
    if (n !== undefined && p !== undefined) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.agent;
      ctx.setLineDash([3 * px, 3 * px]);
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.arc(p.x, p.y, n.r + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // labels: the agent and directories always; memories when zoomed in, lit, hit or selected
  ctx.textBaseline = "middle";
  nodes.forEach((n, i) => {
    const p = pos[i] as { x: number; y: number };
    const dim = dimOf(i);
    const show =
      n.kind !== "memory" ||
      k >= 1.35 ||
      lit.has(i) ||
      i === st.focus ||
      n.id === st.selectedId ||
      (st.highlight?.has(n.id) ?? false);
    if (!show) return;
    const size = n.kind === "agent" ? 12 : 11;
    ctx.font = `${n.kind === "dir" ? "" : "500 "}${size * px}px ${pal.font}`;
    ctx.globalAlpha = (n.kind === "memory" ? 0.9 : n.kind === "dir" ? 0.75 : 1) * dim;
    ctx.fillStyle = n.kind === "dir" ? pal.muted : pal.ink;
    if (n.kind === "agent") {
      ctx.textAlign = "center";
      ctx.fillText(n.label, p.x, p.y + n.r + 18 * px);
    } else {
      ctx.textAlign = "left";
      const label = n.kind === "dir" ? `${n.label}/` : n.label;
      ctx.fillText(label, p.x + n.r + 5 * px, p.y);
    }
  });
  ctx.globalAlpha = 1;
}
