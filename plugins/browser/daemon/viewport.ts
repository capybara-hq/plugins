// Viewport profiles and touch input for the person in control (dialogs spec §7): the mobile user
// agent of the phone profile, and the desktop profile's translation of touch input (a tap is a
// click, a one-finger pan scrolls; anything else is ignored). Pure: no browser here.

/** A tap moves less than this (CSS pixels) from where it started. */
export const TAP_SLOP_PX = 10;
/** A tap lasts less than this. */
export const TAP_MAX_MS = 500;

/**
 * The phone profile's user agent: the browser's own Chrome version in the Android Chrome pattern
 * (a headless build's "HeadlessChrome" is never shown to a site).
 */
export function mobileUserAgent(desktop: string): string {
  const version = /(?:Headless)?Chrome\/(\d+)/.exec(desktop)?.[1] ?? "140";
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Mobile Safari/537.36`;
}

export type TouchAction =
  | { kind: "click"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; dx: number; dy: number };

type Point = { id: number; x: number; y: number };

/**
 * Turns one gesture of touch messages into mouse actions for the desktop profile. One finger
 * only: a second finger ends the gesture as ignored until every finger lifted.
 */
export class TouchTranslator {
  private gesture:
    | { id: number; start: Point; last: Point; at: number; panning: boolean; ignored: boolean }
    | undefined;

  constructor(private readonly now: () => number) {}

  reset(): void {
    this.gesture = undefined;
  }

  feed(kind: "start" | "move" | "end" | "cancel", raw: unknown): TouchAction[] {
    const points = toPoints(raw);
    const g = this.gesture;
    if (kind === "cancel") {
      this.gesture = undefined;
      return [];
    }
    if (kind === "start") {
      if (g !== undefined || points.length !== 1) {
        if (g !== undefined) g.ignored = true;
        else this.gesture = ignoredGesture(points[0], this.now());
        return [];
      }
      const p = points[0] as Point;
      this.gesture = {
        id: p.id,
        start: p,
        last: p,
        at: this.now(),
        panning: false,
        ignored: false,
      };
      return [];
    }
    if (g === undefined) return [];
    if (kind === "move") {
      const p = points.find((x) => x.id === g.id);
      if (g.ignored || p === undefined || points.length !== 1) return [];
      if (!g.panning && Math.hypot(p.x - g.start.x, p.y - g.start.y) < TAP_SLOP_PX) return [];
      g.panning = true;
      const out: TouchAction = {
        kind: "wheel",
        x: p.x,
        y: p.y,
        // the content follows the finger: moving it up scrolls down
        dx: g.last.x - p.x,
        dy: g.last.y - p.y,
      };
      g.last = p;
      return out.dx === 0 && out.dy === 0 ? [] : [out];
    }
    // end: the gesture is over once no finger is left
    if (points.length > 0) return [];
    this.gesture = undefined;
    if (g.ignored || g.panning || this.now() - g.at >= TAP_MAX_MS) return [];
    return [{ kind: "click", x: g.start.x, y: g.start.y }];
  }
}

function ignoredGesture(p: Point | undefined, at: number) {
  const q = p ?? { id: -1, x: 0, y: 0 };
  return { id: q.id, start: q, last: q, at, panning: false, ignored: true };
}

/** The well-formed points of a touch message (finite numbers). */
export function toPoints(raw: unknown): Point[] {
  if (!Array.isArray(raw)) return [];
  const out: Point[] = [];
  for (const r of raw.slice(0, 10)) {
    const p = r as Partial<Point> | null;
    if (typeof p !== "object" || p === null) continue;
    const id = Number(p.id);
    const x = Number(p.x);
    const y = Number(p.y);
    if (Number.isFinite(id) && Number.isFinite(x) && Number.isFinite(y)) out.push({ id, x, y });
  }
  return out;
}
