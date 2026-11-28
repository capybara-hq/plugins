import type { TriggerSource } from "@capybara-hq/plugin-sdk";

/**
 * Minimal `trigger-source@1` provider: declares no events and shows no subject yet (the event
 * declarations and visibility rule are a later task).
 */
export const collabTriggerSource: TriggerSource = {
  events: () => [],
  visible: async () => [],
};
