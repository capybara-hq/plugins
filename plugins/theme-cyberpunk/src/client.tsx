import { type ClientApi, defineClientExtension, defineComponent } from "@capybara-hq/plugin-client";
import { Brand, Hero } from "./brand.js";
import { recordEvent } from "./counts.js";
import { RunHud } from "./hud.js";
import { Boot, Scanlines } from "./overlay.js";
import { PLUGIN } from "./shared.js";
import { type Cue, playCue, soundEnabled } from "./sound.js";

/** Plays a cue only when the viewer turned sound on (off by default) and reduced motion is off. */
export function cue(c: Cue, api: ClientApi): boolean {
  return soundEnabled(api.storage, api.reducedMotion) ? playCue(c) : false;
}

/**
 * The browser side of theme-cyberpunk (client extensions spec §8 / §15): components keyed by the
 * extension manifest's `component` contributions, and the listeners: the HUD's counts (session
 * client storage, from the page's first load) and the sound cues.
 */
export default defineClientExtension({
  name: PLUGIN,
  components: {
    "run-hud": defineComponent("conversation.properties.section", RunHud),
    scanlines: defineComponent("shell.overlay", Scanlines),
    boot: defineComponent("shell.overlay", Boot),
    brand: defineComponent("shell.brand", Brand),
    hero: defineComponent("conversation.empty", Hero),
  },
  events: {
    "run.started": (e, api) => {
      recordEvent(api.storage, e);
      cue("start", api);
    },
    "run.finished": (e, api) => {
      cue(e.reason === "aborted" ? "error" : "done", api);
    },
    "run.failed": (_e, api) => {
      cue("error", api);
    },
    "approval.requested": (e, api) => {
      recordEvent(api.storage, e);
      cue("alert", api);
    },
    "tool.finished": (e, api) => {
      recordEvent(api.storage, e);
      cue(e.isError ? "error" : "tick", api);
    },
  },
});
