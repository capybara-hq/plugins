import { type RunState, usePrefersReducedMotion, useRunState } from "@capybara-hq/plugin-client";
import { type CSSProperties, useEffect, useState } from "react";
import { cx } from "./shared.js";

/** A box on the viewport, in CSS pixels (rounded). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the run effects go: the reply being written and the composer, as they are on screen. */
export interface FxLayout {
  /** The visible part of the newest assistant message, and whether its bottom edge is visible. */
  reply: (Box & { edge: boolean }) | null;
  composer: Box | null;
}

const part = (name: string) => `[data-cap-part~="${name}"]`;

const box = (r: DOMRect): Box => ({
  x: Math.round(r.left),
  y: Math.round(r.top),
  w: Math.round(r.width),
  h: Math.round(r.height),
});

/**
 * Measures the parts the effects sit on, by their public `data-cap-part` names only: the last
 * `message.assistant` of the `thread` (the reply being written while a run goes), clipped to the
 * band between the title bar and the composer, and the `composer`.
 */
export function measureFx(doc: Document, viewportHeight: number): FxLayout {
  const replies = doc.querySelectorAll(`${part("thread")} ${part("message.assistant")}`);
  const last = replies[replies.length - 1];
  const composerEl = doc.querySelector(part("composer"));
  const titleEl = doc.querySelector(part("title-bar"));
  const composer = composerEl === null ? null : box(composerEl.getBoundingClientRect());
  const top = titleEl === null ? 0 : Math.round(titleEl.getBoundingClientRect().bottom);
  const bottom = composer === null ? viewportHeight : composer.y;
  let reply: FxLayout["reply"] = null;
  if (last !== undefined) {
    const r = box(last.getBoundingClientRect());
    const y1 = Math.max(r.y, top);
    const y2 = Math.min(r.y + r.h, bottom);
    if (r.w > 0 && y2 - y1 > 4)
      reply = { x: r.x, y: y1, w: r.w, h: y2 - y1, edge: r.y + r.h <= bottom };
  }
  return { reply, composer: composer !== null && composer.w > 0 ? composer : null };
}

const same = (a: FxLayout, b: FxLayout) => JSON.stringify(a) === JSON.stringify(b);

const placed = (b: Box): CSSProperties => ({
  transform: `translate(${b.x}px, ${b.y}px)`,
  width: b.w,
  height: b.h,
});

/**
 * The run effects, drawn in the decoration layer over the parts they belong to (never inside the
 * host's markup, so they shift no layout): while running, a scan beam passes over the reply being
 * written, a write head glows under its newest line and a light travels along the composer's
 * border; while waiting, the composer's outline breathes. Positions follow the parts on animation
 * frames while a run is active; nothing is drawn when idle or failed, or under reduced motion.
 */
export function RunFx() {
  const { state } = useRunState();
  const reducedMotion = usePrefersReducedMotion();
  const active = !reducedMotion && (state === "running" || state === "waiting");
  const [layout, setLayout] = useState<FxLayout | null>(null);

  useEffect(() => {
    if (!active) {
      setLayout(null);
      return;
    }
    let frame = 0;
    let current: FxLayout | null = null;
    const tick = () => {
      const next = measureFx(document, window.innerHeight);
      if (current === null || !same(current, next)) {
        current = next;
        setLayout(next);
      }
      frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  if (!active || layout === null) return null;
  return <FxLayer state={state} layout={layout} />;
}

/** The effect elements for a run state and a layout (separate for tests). */
export function FxLayer({ state, layout }: { state: RunState; layout: FxLayout }) {
  const running = state === "running";
  return (
    <div aria-hidden="true" className={cx("fx")}>
      {running && layout.reply !== null ? (
        <div className={cx("fx-box")} style={placed(layout.reply)} data-fx="reply">
          <div className={cx("fx-beam")} />
          {layout.reply.edge ? <div className={cx("fx-edge")} /> : null}
        </div>
      ) : null}
      {layout.composer !== null ? (
        <div
          className={`${cx("fx-box")} ${cx("fx-composer")}`}
          style={placed(layout.composer)}
          data-fx="composer"
        >
          {running ? (
            <>
              <div className={cx("fx-comet")} />
              <div className={cx("fx-comet")} />
            </>
          ) : (
            <div className={cx("fx-ring")} />
          )}
        </div>
      ) : null}
    </div>
  );
}
