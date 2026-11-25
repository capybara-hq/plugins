import { describe, expect, it } from "vitest";
import {
  FramePacer,
  FrameQuality,
  QUALITY_STEPS,
  SHRINK_STEPS,
  TARGET_LINK_MS,
} from "../../daemon/viewer-pacing.js";

/** About how a JPEG's size follows its quality (relative to quality 60). */
const QUALITY_FACTOR: Record<number, number> = { 60: 1, 45: 0.78, 35: 0.62, 25: 0.48 };

/**
 * A pacer (and optionally the quality ladder) on a modelled link: `owMs` one way, `rate` bytes/s
 * on one FIFO bottleneck that frames and pings cross; frames always available (an animated page).
 * Returns how long a click reaching the bottleneck would wait behind frame bytes, per ms after 10 s.
 */
function simulate(opts: { owMs: number; rate: number; adapt: boolean; frameBytes?: number }) {
  const big = opts.frameBytes ?? 130 * 1024;
  const p = new FramePacer({ maxFps: 15, maxUnacked: 2 });
  const q = new FrameQuality();
  let now = 0;
  let linkFree = 0;
  let seq = 0;
  let restartedAt = Number.NEGATIVE_INFINITY;
  const events: { at: number; run: () => void }[] = [];
  const cross = (bytes: number) => {
    const start = Math.max(now + opts.owMs / 2, linkFree);
    linkFree = start + (bytes / opts.rate) * 1000;
    return linkFree + opts.owMs / 2;
  };
  const sizes: number[] = [];
  const wait: number[] = [];
  let frames = 0;
  while (now < 30_000) {
    events.sort((a, b) => a.at - b.at);
    while (events.length > 0 && (events[0] as { at: number }).at <= now) events.shift()?.run();
    if (now % 1000 === 0) {
      const sentAt = now;
      // the ping crosses the bottleneck like any message; the pong returns unqueued
      const arrive = cross(40);
      events.push({ at: arrive + opts.owMs, run: () => p.pinged(arrive + opts.owMs - sentAt) });
    }
    if (p.decide(now).ok) {
      const s = ++seq;
      const bytes = Math.round(big * (QUALITY_FACTOR[q.quality] ?? 1) * q.shrink ** 2);
      p.sent(s, now);
      if (now > 10_000) {
        sizes.push(bytes);
        frames++;
      }
      const arrive = cross(bytes);
      events.push({
        at: arrive + opts.owMs,
        run: () => {
          const sample = p.acked(s, arrive + opts.owMs);
          if (!opts.adapt || sample === undefined) return;
          // the viewer restarts the screencast at most every 500 ms
          if (arrive + opts.owMs - restartedAt < 500) return;
          if (q.observe(p.linkMs ?? sample)) {
            restartedAt = arrive + opts.owMs;
            p.reset();
          }
        },
      });
    }
    if (now > 10_000) wait.push(Math.max(0, linkFree - (now + opts.owMs / 2)));
    now += 1;
  }
  wait.sort((a, b) => a - b);
  const pct = (x: number) => wait[Math.floor(wait.length * x)] as number;
  return { p, q, pct, fps: frames / 20, sizes };
}

describe("frame pacer", () => {
  it("lets frames through at the rate cap while frames cross quickly", () => {
    const p = new FramePacer({ maxFps: 15, maxUnacked: 2 });
    expect(p.decide(0).ok).toBe(true);
    p.sent(1, 0);
    const d = p.decide(10);
    expect(d.ok).toBe(false);
    expect(d.waitMs).toBeCloseTo(1000 / 15 - 10, 5);
    p.pinged(3);
    expect(p.acked(1, 5)).toBe(2);
    expect(p.decide(67).ok).toBe(true);
  });

  it("holds the next frame while the window is full and frees it on an ack", () => {
    const p = new FramePacer({ maxFps: 1000, maxUnacked: 2 });
    p.sent(1, 0);
    p.sent(2, 1);
    expect(p.decide(5)).toEqual({ ok: false });
    p.acked(2, 6);
    expect(p.unacked).toBe(0);
    expect(p.decide(7).ok).toBe(true);
  });

  it("allows no second frame in flight while frames take longer than the target", () => {
    const p = new FramePacer({ maxFps: 1000, maxUnacked: 2 });
    p.pinged(100);
    p.sent(1, 0);
    p.acked(1, 100 + TARGET_LINK_MS * 3);
    p.sent(2, 1000);
    expect(p.decide(1100)).toEqual({ ok: false });
  });

  it("on a slow link, adapted frames keep a click's wait near the target", () => {
    const slow = simulate({ owMs: 105, rate: 350 * 1024, adapt: true });
    // how long a click waits behind frame bytes, 90 % of the time
    expect(slow.pct(0.9)).toBeLessThan(TARGET_LINK_MS * 1.5);
    expect(slow.fps).toBeGreaterThan(1);
  });

  it("frames that stay large keep a click waiting far longer on the same link", () => {
    const fixed = simulate({ owMs: 105, rate: 350 * 1024, adapt: false });
    expect(fixed.pct(0.9)).toBeGreaterThan(300);
  });

  it("a fast link keeps the best picture at the full rate", () => {
    const fast = simulate({ owMs: 2, rate: 50 * 1024 * 1024, adapt: true });
    expect([fast.q.quality, fast.q.shrink]).toEqual([60, 1]);
    expect(fast.fps).toBeGreaterThan(14);
  });
});

describe("frame quality", () => {
  it("steps quality down first, then scale, and back up after quick frames", () => {
    const q = new FrameQuality();
    const slow = TARGET_LINK_MS * 2;
    expect([q.quality, q.shrink]).toEqual([60, 1]);
    for (let i = 1; i < QUALITY_STEPS.length; i++) expect(q.observe(slow)).toBe(true);
    expect(q.quality).toBe(QUALITY_STEPS.at(-1));
    expect(q.shrink).toBe(1);
    expect(q.observe(slow)).toBe(true);
    expect(q.shrink).toBe(SHRINK_STEPS[1]);
    // the link adaptation stops at half size
    for (let i = 0; i < 10; i++) q.observe(slow);
    expect(q.shrink).toBe(0.5);
    // a frame over the message cap still goes smaller
    expect(q.tooLarge()).toBe(true);
    expect(q.shrink).toBe(0.35);
    // six quick frames step back up once
    let changed = 0;
    for (let i = 0; i < 6; i++) if (q.observe(0)) changed++;
    expect(changed).toBe(1);
    expect(q.shrink).toBe(0.5);
  });

  it("frames between half and the full target change nothing", () => {
    const q = new FrameQuality();
    q.observe(TARGET_LINK_MS * 2);
    for (let i = 0; i < 20; i++) expect(q.observe(TARGET_LINK_MS * 0.8)).toBe(false);
    expect(q.quality).toBe(QUALITY_STEPS[1]);
  });
});
