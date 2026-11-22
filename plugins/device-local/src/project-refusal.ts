import { ProjectPathRefusedError } from "@capybara-hq/plugin-sdk";
import type { DeviceProjectRefusal } from "@capybara-hq/plugin-sdk/device-protocol";

/**
 * The fixed text a person sees for each refusal code of a `project_refused` outcome. The machine
 * is not trusted: its message text never reaches the person, only the code picks the text.
 */
export const PROJECT_REFUSAL_TEXT: Readonly<
  Record<DeviceProjectRefusal, { en: string; zh: string }>
> = Object.freeze({
  "other-connection": Object.freeze({
    en: "This directory belongs to another connection on this machine.",
    zh: "这个目录属于本机上的另一个连接。",
  }),
  "outside-reach": Object.freeze({
    en: "This directory is outside the project reach the machine's owner set for this device.",
    zh: "这个目录不在本机所有者为此设备设定的项目范围内。",
  }),
  denied: Object.freeze({
    en: "This directory holds secrets or the device program's own state.",
    zh: "这个目录存放密钥或设备程序自身的状态。",
  }),
});

/** The provider's refusal of a project directory for a machine's refusal code. */
export function projectRefusalError(refusal: DeviceProjectRefusal): ProjectPathRefusedError {
  const text = PROJECT_REFUSAL_TEXT[refusal];
  return new ProjectPathRefusedError({ en: text.en, zh: text.zh });
}
