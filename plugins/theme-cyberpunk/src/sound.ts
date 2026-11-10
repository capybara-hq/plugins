import type { ClientStorage } from "@capybara-hq/plugin-client";
import { SOUND_KEY } from "./shared.js";

/** The cues the plugin plays: run start / finish, an approval, a tool result, an error, toggle on. */
export type Cue = "start" | "done" | "alert" | "tick" | "error" | "on";

interface Tone {
  type: OscillatorType;
  /** Start frequency (Hz) and, for a sweep, the end frequency. */
  freq: number;
  to?: number;
  /** Offset from the cue's start and length, in seconds. */
  at: number;
  dur: number;
}

/** The tones of a cue: short synthesized blips, so the plugin ships no audio files. */
function tones(cue: Cue): Tone[] {
  switch (cue) {
    case "start":
      return [
        { type: "square", freq: 440, to: 880, at: 0, dur: 0.09 },
        { type: "square", freq: 880, at: 0.1, dur: 0.06 },
      ];
    case "done":
      return [
        { type: "triangle", freq: 660, at: 0, dur: 0.09 },
        { type: "triangle", freq: 880, at: 0.09, dur: 0.09 },
        { type: "triangle", freq: 1320, at: 0.18, dur: 0.16 },
      ];
    case "alert":
      return [
        { type: "square", freq: 1180, at: 0, dur: 0.07 },
        { type: "square", freq: 1180, at: 0.12, dur: 0.07 },
      ];
    case "tick":
      return [{ type: "triangle", freq: 1760, at: 0, dur: 0.035 }];
    case "error":
      return [{ type: "sawtooth", freq: 220, to: 110, at: 0, dur: 0.18 }];
    case "on":
      return [
        { type: "sine", freq: 520, to: 1040, at: 0, dur: 0.12 },
        { type: "sine", freq: 1560, at: 0.12, dur: 0.08 },
      ];
  }
}

/** Whether the viewer turned sound on (off by default) and reduced motion is off. */
export function soundEnabled(storage: ClientStorage, reducedMotion: boolean): boolean {
  return !reducedMotion && storage.get(SOUND_KEY) === "on";
}

type AudioContextCtor = new () => AudioContext;

/** Length of a cue in seconds (its last tone's end plus the release). */
function cueSeconds(list: Tone[]): number {
  return list.reduce((end, t) => Math.max(end, t.at + t.dur), 0) + 0.05;
}

/** When the cue playing now ends (performance.now() ms): cues never overlap or pile up. */
// capybara:allow-module-state browser-only state, one per document: the end of the current cue
let playingUntil = 0;

/**
 * Whether the page may start audio now: browsers keep an AudioContext made before the first user
 * gesture suspended, and cues queued then would all start together at the first click (a burst of
 * replayed catch-up events). Browsers without `navigator.userActivation` are allowed.
 */
function pageActivated(): boolean {
  const nav = (globalThis as { navigator?: { userActivation?: { hasBeenActive?: boolean } } })
    .navigator;
  return nav?.userActivation?.hasBeenActive !== false;
}

/**
 * Plays a cue with the Web Audio API, quietly. One cue at a time: a cue asked for while another
 * plays is dropped, so a burst of events plays once. Nothing plays before the page's first user
 * gesture. Each cue gets its own AudioContext, closed when its last tone ends, or at once when the
 * browser does not let it run, so no context outlives its cue. Returns whether a cue started.
 */
export function playCue(cue: Cue): boolean {
  const g = globalThis as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (Ctor === undefined || !pageActivated()) return false;
  const now = performance.now();
  if (now < playingUntil) return false;
  let audio: AudioContext;
  try {
    audio = new Ctor();
  } catch {
    return false;
  }
  const list = tones(cue);
  playingUntil = now + cueSeconds(list) * 1000;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    audio.close().catch(() => {});
  };
  const master = audio.createGain();
  master.gain.value = 0.05;
  master.connect(audio.destination);
  const t0 = audio.currentTime + 0.01;
  let last: OscillatorNode | undefined;
  for (const tone of list) {
    const start = t0 + tone.at;
    const end = start + tone.dur;
    const osc = audio.createOscillator();
    const env = audio.createGain();
    osc.type = tone.type;
    osc.frequency.setValueAtTime(tone.freq, start);
    if (tone.to !== undefined) osc.frequency.exponentialRampToValueAtTime(tone.to, end);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(1, start + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(env);
    env.connect(master);
    osc.start(start);
    osc.stop(end + 0.02);
    last = osc;
  }
  if (last !== undefined) last.onended = close;
  // A context the browser keeps suspended never reaches onended: close it, and free the slot.
  const settle = () => {
    if (audio.state !== "running") {
      close();
      playingUntil = 0;
    }
  };
  audio.resume().then(settle, settle);
  return true;
}
