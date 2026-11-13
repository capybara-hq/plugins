import { describe, expect, it } from "vitest";
import {
  AGENT_ID,
  brightnessOf,
  dirId,
  draw,
  fitCamera,
  hitTest,
  layout,
  type Palette,
  radiusOf,
  type Sim,
  settle,
  step,
  toWorld,
  zoomAt,
} from "../src/client/graph.js";
import type { GraphEdge, GraphNode } from "../src/page.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function node(id: string, path: string, recalls = 0, last: string | null = null): GraphNode {
  const slash = path.lastIndexOf("/");
  return {
    id,
    path,
    type: path.split("/")[0] as GraphNode["type"],
    description: `About ${path}`,
    recalls,
    lastRecalledAt: last,
    dir: path.slice(0, slash),
  };
}

const NODES = [
  node("m-coffee", "user/coffee.md", 9, daysAgo(1)),
  node("m-reply", "feedback/reply-in-chinese.md", 100, daysAgo(0)),
  node("m-probe", "project/github/probe.md", 0, null),
  node("m-plan", "project/plan.md", 2, daysAgo(40)),
  node("m-docs", "reference/docs.md"),
];
const EDGES: GraphEdge[] = [
  { from: "m-coffee", to: "m-reply", kind: "link" },
  { from: "m-probe", to: "m-plan", kind: "semantic", score: 0.81 },
  { from: "m-plan", to: "m-probe", kind: "semantic", score: 0.81 },
  { from: "m-coffee", to: "gone", kind: "link" },
];

const build = (previous: Sim | null = null) =>
  layout({ nodes: NODES, edges: EDGES, agentLabel: "Helper" }, { now: NOW, previous });

const at = (sim: Sim, id: string) => sim.nodes[sim.index.get(id) as number];
const parentOf = (sim: Sim, id: string) => sim.nodes[at(sim, id)?.parent ?? -1]?.id;

describe("layout", () => {
  it("has the agent, the four type directories, the nested directory and the leaves", () => {
    const sim = build();
    const kinds = sim.nodes.map((n) => n.kind);
    expect(kinds.filter((k) => k === "agent")).toHaveLength(1);
    expect(sim.nodes.filter((n) => n.kind === "dir").map((n) => n.id)).toEqual([
      dirId("user"),
      dirId("feedback"),
      dirId("project"),
      dirId("reference"),
      dirId("project/github"),
    ]);
    expect(kinds.filter((k) => k === "memory")).toHaveLength(5);
    expect(sim.nodes[0]?.id).toBe(AGENT_ID);
    expect(sim.nodes[0]?.label).toBe("Helper");
  });

  it("chains directories to their parent and leaves to their directory", () => {
    const sim = build();
    for (const t of ["user", "feedback", "project", "reference"]) {
      expect(parentOf(sim, dirId(t))).toBe(AGENT_ID);
    }
    expect(parentOf(sim, dirId("project/github"))).toBe(dirId("project"));
    expect(parentOf(sim, "m-probe")).toBe(dirId("project/github"));
    expect(parentOf(sim, "m-plan")).toBe(dirId("project"));
    expect(parentOf(sim, "m-coffee")).toBe(dirId("user"));
    // one tree edge per non-agent node
    expect(sim.edges.filter((e) => e.kind === "tree")).toHaveLength(sim.nodes.length - 1);
    for (const e of sim.edges.filter((x) => x.kind === "tree")) {
      expect(sim.nodes[e.b]?.parent).toBe(e.a);
    }
  });

  it("keeps resolved links, one semantic edge per pair, and drops edges to unknown nodes", () => {
    const sim = build();
    const cross = sim.edges
      .filter((e) => e.kind !== "tree")
      .map((e) => `${e.kind}:${sim.nodes[e.a]?.id}-${sim.nodes[e.b]?.id}`);
    expect(cross).toEqual(["link:m-coffee-m-reply", "semantic:m-probe-m-plan"]);
    expect(
      sim.adjacency[sim.index.get("m-coffee") as number]?.has(sim.index.get("m-reply") as number),
    ).toBe(true);
  });

  it("is deterministic, and a rebuild keeps the positions of the nodes that stay", () => {
    const a = build();
    const b = build();
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
    settle(a);
    const c = layout(
      { nodes: [...NODES, node("m-new", "user/new.md")], edges: EDGES, agentLabel: "Helper" },
      { now: NOW, previous: a },
    );
    expect(at(c, "m-coffee")?.x).toBe(at(a, "m-coffee")?.x);
    expect(at(c, "m-coffee")?.y).toBe(at(a, "m-coffee")?.y);
    expect(c.alpha).toBeLessThan(1);
  });

  it("sizes by recalls and lights by recency", () => {
    expect(radiusOf(0)).toBe(4);
    expect(radiusOf(9)).toBeCloseTo(7.6, 5);
    expect(radiusOf(100)).toBeCloseTo(16, 5);
    expect(radiusOf(10_000)).toBe(18);
    expect(brightnessOf(daysAgo(0), NOW)).toBe(1);
    expect(brightnessOf(daysAgo(30), NOW)).toBeCloseTo(Math.exp(-1), 5);
    expect(brightnessOf(daysAgo(365), NOW)).toBe(0.25);
    expect(brightnessOf(null, NOW)).toBe(0.25);
    const sim = build();
    expect(at(sim, "m-reply")?.r).toBeCloseTo(16, 5);
    expect(at(sim, "m-reply")?.recent).toBe(true);
    expect(at(sim, "m-plan")?.recent).toBe(false);
    expect(at(sim, "m-probe")?.brightness).toBe(0.25);
  });
});

describe("simulation", () => {
  it("cools down and settles; the agent stays at the centre", () => {
    const sim = build();
    const before = sim.alpha;
    step(sim);
    expect(sim.alpha).toBeLessThan(before);
    settle(sim);
    expect(sim.alpha).toBe(0);
    expect([sim.nodes[0]?.x, sim.nodes[0]?.y]).toEqual([0, 0]);
    for (const n of sim.nodes) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    }
  });

  it("separates memories so they do not overlap", () => {
    const many = Array.from({ length: 60 }, (_, i) => node(`m${i}`, `user/n${i}.md`, i));
    const sim = layout({ nodes: many, edges: [], agentLabel: "A" }, { now: NOW });
    settle(sim);
    const leaves = sim.nodes.filter((n) => n.kind === "memory");
    let overlaps = 0;
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i];
        const b = leaves[j];
        if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * 0.8) overlaps++;
      }
    }
    expect(overlaps).toBe(0);
  });
});

describe("camera and hit testing", () => {
  it("finds the node under a point, fits the view and zooms around the pointer", () => {
    const sim = build();
    settle(sim);
    const reply = sim.index.get("m-reply") as number;
    const n = sim.nodes[reply];
    expect(hitTest(sim, (n?.x ?? 0) + 3, n?.y ?? 0)).toBe(reply);
    expect(hitTest(sim, 5000, 5000)).toBe(-1);

    const cam = fitCamera(sim, 800, 600);
    for (const x of sim.nodes) {
      const sx = x.x * cam.k + cam.x;
      const sy = x.y * cam.k + cam.y;
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(800);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThanOrEqual(600);
    }
    const before = toWorld(cam, 200, 150);
    const zoomed = zoomAt(cam, 200, 150, 2);
    expect(zoomed.k).toBeCloseTo(cam.k * 2, 5);
    const after = toWorld(zoomed, 200, 150);
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
  });
});

describe("drawing", () => {
  const palette: Palette = {
    type: {
      user: "tok-user",
      feedback: "tok-feedback",
      project: "tok-project",
      reference: "tok-ref",
    },
    agent: "tok-agent",
    ink: "tok-ink",
    muted: "tok-muted",
    faint: "tok-faint",
    bg: "tok-bg",
    font: "tok-font",
  };

  /** A 2D context that records the fill styles of the arcs it fills, and the dashes it strokes. */
  function recorder() {
    const fills: string[] = [];
    const dashes: number[][] = [];
    let fillStyle = "";
    let dash: number[] = [];
    const ctx = new Proxy(
      {},
      {
        get(_t, key) {
          if (key === "fill") return () => fills.push(fillStyle);
          if (key === "setLineDash")
            return (d: number[]) => {
              dash = d;
            };
          if (key === "stroke") return () => dashes.push(dash);
          if (key === "fillStyle") return fillStyle;
          return () => {};
        },
        set(_t, key, value) {
          if (key === "fillStyle") fillStyle = value;
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
    return { ctx, fills, dashes };
  }

  const state = (motion: boolean) => ({
    width: 800,
    height: 600,
    dpr: 2,
    time: 1234,
    motion,
    hover: -1,
    focus: -1,
    selectedId: null,
    highlight: null,
  });

  it("colours memories by type from the palette and dashes only semantic edges", () => {
    const sim = build();
    settle(sim);
    const r = recorder();
    draw(r.ctx, sim, fitCamera(sim, 800, 600), palette, state(false));
    for (const tok of ["tok-user", "tok-feedback", "tok-project", "tok-ref", "tok-agent"]) {
      expect(r.fills).toContain(tok);
    }
    // one dashed stroke: the single semantic pair
    expect(r.dashes.filter((d) => d.length > 0)).toHaveLength(1);
  });

  it("draws pulses only with motion", () => {
    const sim = build();
    settle(sim);
    const still = recorder();
    draw(still.ctx, sim, fitCamera(sim, 800, 600), palette, state(false));
    const moving = recorder();
    draw(moving.ctx, sim, fitCamera(sim, 800, 600), palette, state(true));
    expect(moving.fills.length).toBeGreaterThan(still.fills.length);
  });
});
