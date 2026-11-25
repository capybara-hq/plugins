// Frame pacing for one viewer (browser use spec §6.2): how many screencast frames may be in flight
// and how large they should be, from the viewer's acks and pings. A frame's bytes share the slowest
// hop with the person's input: a click that reaches the hop behind a frame waits until the frame is
// through. So the daemon watches how much longer a frame's round trip takes than a tiny message's
// (`ping`: the path's own round trip) and keeps that "link time" near TARGET_LINK_MS, lowering
// quality and then scale when frames take longer, and allowing a second frame in flight only while
// they are quick. Pure: no timers, the caller passes the time.

/** The link time a frame should stay under (how long a click may wait behind it). */
export const TARGET_LINK_MS = 120;
/** Ping round trips kept: the smallest is the path's round trip without queueing. */
const PING_WINDOW = 10;
/** Frame round trips kept when no ping answered yet (the smallest stands in for the path). */
const RTT_WINDOW = 16;
/** A link time sample's weight in the running value. */
const LINK_ALPHA = 0.5;

interface Sent {
  seq: number;
  at: number;
}

export interface PacerDecision {
  /** Whether a frame may be sent now. */
  ok: boolean;
  /** When !ok and only the rate cap holds it: how long until it may. Undefined: wait for an ack. */
  waitMs?: number;
}

export class FramePacer {
  private readonly minIntervalMs: number;
  private readonly maxUnacked: number;
  private readonly inFlight: Sent[] = [];
  private readonly pings: number[] = [];
  private readonly rtts: number[] = [];
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private link: number | undefined;

  constructor(opts: { maxFps: number; maxUnacked: number }) {
    this.minIntervalMs = 1000 / opts.maxFps;
    this.maxUnacked = opts.maxUnacked;
  }

  /** The smoothed time frames take over the path's own round trip; undefined before any ack. */
  get linkMs(): number | undefined {
    return this.link;
  }

  get unacked(): number {
    return this.inFlight.length;
  }

  /** The path's round trip without queueing, as far as measured. */
  get baseRttMs(): number | undefined {
    if (this.pings.length > 0) return Math.min(...this.pings);
    if (this.rtts.length > 0) return Math.min(...this.rtts);
    return undefined;
  }

  /** Whether a frame may be sent at `now`, and if only the rate cap holds it, for how long. */
  decide(now: number): PacerDecision {
    const n = this.inFlight.length;
    if (n >= this.maxUnacked) return { ok: false };
    // a second frame only while frames cross quickly: otherwise it would queue ahead of input
    if (n > 0 && this.link !== undefined && this.link > TARGET_LINK_MS) return { ok: false };
    const wait = this.lastSentAt + this.minIntervalMs - now;
    return wait > 0 ? { ok: false, waitMs: wait } : { ok: true };
  }

  /** Records a frame sent at `now` (every frame counts, the first after an attach too). */
  sent(seq: number, now: number): void {
    this.inFlight.push({ seq, at: now });
    this.lastSentAt = now;
  }

  /** Records the viewer's ack of every frame up to `seq` at `now`; returns the sample, if any. */
  acked(seq: number, now: number): number | undefined {
    let last: Sent | undefined;
    while (this.inFlight.length > 0 && (this.inFlight[0] as Sent).seq <= seq) {
      last = this.inFlight.shift();
    }
    if (last === undefined) return undefined;
    const rtt = Math.max(0, now - last.at);
    this.rtts.push(rtt);
    if (this.rtts.length > RTT_WINDOW) this.rtts.shift();
    const sample = Math.max(0, rtt - (this.baseRttMs ?? rtt));
    this.link =
      this.link === undefined ? sample : this.link * (1 - LINK_ALPHA) + sample * LINK_ALPHA;
    return sample;
  }

  /** Records a ping's round trip (a tiny message both ways on the same path as the frames). */
  pinged(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    this.pings.push(rttMs);
    if (this.pings.length > PING_WINDOW) this.pings.shift();
  }

  /** Forgets frames in flight (a screencast restart: their acks may never come). */
  reset(): void {
    this.inFlight.length = 0;
  }
}

/** The JPEG quality steps the adaptation walks (the highest first). */
export const QUALITY_STEPS = [60, 45, 35, 25] as const;
/**
 * The scale steps tried once the lowest quality is still too slow or too large. The link
 * adaptation stops at half size (text stays readable); only a frame over the message cap goes
 * smaller.
 */
export const SHRINK_STEPS = [1, 0.8, 0.65, 0.5, 0.35, 0.25] as const;
const ADAPT_SHRINK_STEPS = 4;
/** Quick frames in a row before stepping back up. */
const UP_AFTER_QUICK_FRAMES = 6;

/**
 * Walks quality and then scale down while frames take longer than the target link time, and back
 * up while they are well under it. `step` is one index over both ladders: 0 is the best picture.
 */
export class FrameQuality {
  private step = 0;
  private quick = 0;

  get quality(): number {
    return QUALITY_STEPS[Math.min(this.step, QUALITY_STEPS.length - 1)] as number;
  }

  get shrink(): number {
    const s = Math.max(0, this.step - (QUALITY_STEPS.length - 1));
    return SHRINK_STEPS[Math.min(s, SHRINK_STEPS.length - 1)] as number;
  }

  /** The lowest step the link adaptation goes to. */
  private get adaptMaxStep(): number {
    return QUALITY_STEPS.length - 1 + ADAPT_SHRINK_STEPS - 1;
  }

  private get maxStep(): number {
    return QUALITY_STEPS.length - 1 + SHRINK_STEPS.length - 1;
  }

  /** One acked frame's link time; true when the step changed (restart the screencast). */
  observe(linkMs: number): boolean {
    if (linkMs > TARGET_LINK_MS * 1.25) {
      this.quick = 0;
      if (this.step >= this.adaptMaxStep) return false;
      this.step++;
      return true;
    }
    if (linkMs < TARGET_LINK_MS / 2) {
      this.quick++;
      if (this.quick >= UP_AFTER_QUICK_FRAMES && this.step > 0) {
        this.step--;
        this.quick = 0;
        return true;
      }
    } else this.quick = 0;
    return false;
  }

  /** A frame too large for one message: always one step smaller. */
  tooLarge(): boolean {
    this.quick = 0;
    if (this.step >= this.maxStep) return false;
    this.step++;
    return true;
  }
}
