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

/**
 * Plays a cue with the Web Audio API, quietly. Each cue gets its own AudioContext, closed when its
 * last tone ends (no state kept between cues). Returns false when the browser has no Web Audio.
 */
export function playCue(cue: Cue): boolean {
  const g = globalThis as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (Ctor === undefined) return false;
  let audio: AudioContext;
  try {
    audio = new Ctor();
  } catch {
    return false;
  }
  const master = audio.createGain();
  master.gain.value = 0.05;
  master.connect(audio.destination);
  const t0 = audio.currentTime + 0.01;
  let last: OscillatorNode | undefined;
  for (const tone of tones(cue)) {
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
  if (last !== undefined) {
    last.onended = () => {
      audio.close().catch(() => {});
    };
  }
  // A context made before any user gesture starts suspended; resuming may be refused, then the
  // cue stays silent (sound is a nicety).
  audio.resume().catch(() => {});
  return true;
}
