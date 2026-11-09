import {
  type ClientApi,
  type ClientComponent,
  type ComponentProps,
  type ComponentSlotId,
  defineClientExtension,
  defineComponent,
} from "@capybara-hq/plugin-client";
import type { ComponentType } from "react";
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
 * `defineComponent` for the `components` map. plugin-client 0.1.0-rc.1 types the map as
 * `Record<string, ClientComponent>` (every slot's props at once), which a component bound to one
 * slot is not assignable to under strict function types; the binding is still checked here.
 */
function component<S extends ComponentSlotId>(
  slot: S,
  render: ComponentType<ComponentProps<S>>,
): ClientComponent {
  return defineComponent(slot, render) as unknown as ClientComponent;
}

/**
 * The browser side of theme-cyberpunk (client extensions spec §8 / §15): components keyed by the
 * extension manifest's `component` contributions, and the listeners: the HUD's counts (session
 * client storage, from the page's first load) and the sound cues.
 */
export default defineClientExtension({
  name: PLUGIN,
  components: {
    "run-hud": component("conversation.properties.section", RunHud),
    scanlines: component("shell.overlay", Scanlines),
    boot: component("shell.overlay", Boot),
    brand: component("shell.brand", Brand),
    hero: component("conversation.empty", Hero),
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
