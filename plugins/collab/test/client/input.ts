import { act } from "react";

/** Types into a controlled input the way React notices (the native value setter, then input). */
export async function fireInput(
  el: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
): Promise<void> {
  if (el === null) throw new Error("no input");
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
