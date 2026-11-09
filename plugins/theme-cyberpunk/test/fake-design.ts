import { createElement, type ReactNode } from "react";

/**
 * Richer stand-ins for the design components than the fake host's (which render only
 * `children`): a clickable Button and a KeyValue that shows its rows, so tests can press the
 * sound toggle and read the HUD values. They replace entries in the host global that
 * `@capybara-hq/plugin-client` reads on every render (client extensions spec §9.4), so call this
 * after `renderWithFakeHost` and rerender; the fake host restores the global on unmount.
 */
export function installRicherDesign(): void {
  const host = (globalThis as Record<string, unknown>).__CAPYBARA_CLIENT_HOST__ as
    | { design: Record<string, unknown> }
    | undefined;
  if (host === undefined) throw new Error("render with renderWithFakeHost first");
  host.design = {
    ...host.design,
    Button: ({
      children,
      onClick,
      title,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      title?: string;
    }) =>
      createElement(
        "button",
        { type: "button", "data-fake-design": "Button", onClick, title },
        children,
      ),
    KeyValue: ({ rows }: { rows: { k: ReactNode; v: ReactNode }[] }) =>
      createElement(
        "dl",
        { "data-fake-design": "KeyValue" },
        rows.map((r, i) =>
          createElement(
            "div",
            { key: i, "data-row": "" },
            createElement("dt", null, r.k),
            createElement("dd", null, r.v),
          ),
        ),
      ),
  };
}

/** The value of the KeyValue row whose key reads `key`. */
export function row(key: string): string | null {
  for (const r of document.querySelectorAll("[data-row]")) {
    if (r.querySelector("dt")?.textContent === key)
      return r.querySelector("dd")?.textContent ?? null;
  }
  return null;
}

/** The fake design Button whose text starts with `text`. */
export function button(text: string): HTMLButtonElement {
  const b = [...document.querySelectorAll("button")].find((x) =>
    (x.textContent ?? "").startsWith(text),
  );
  if (b === undefined) throw new Error(`no button "${text}"`);
  return b;
}

/** A Web Audio stand-in that counts the contexts (one per cue) and the tones they schedule. */
export class FakeAudioContext {
  static contexts = 0;
  static tones = 0;
  currentTime = 0;
  destination = {};
  constructor() {
    FakeAudioContext.contexts += 1;
  }
  static reset(): void {
    FakeAudioContext.contexts = 0;
    FakeAudioContext.tones = 0;
  }
  createGain() {
    const param = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    return { gain: param, connect() {} };
  }
  createOscillator() {
    FakeAudioContext.tones += 1;
    const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    return { type: "sine", frequency: param, connect() {}, start() {}, stop() {}, onended: null };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
