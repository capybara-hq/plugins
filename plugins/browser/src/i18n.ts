// The plugin server's text for people (zh and en). zh says 智能体, never 企业 or the Latin "agent".

/**
 * The handoff question: a short title (the prefix and the reason's start), the agent's full reason
 * as the body, and two buttons on `{ done }`: 完成 (true) hands the browser back, 取消 (false).
 */
export const HANDOFF_FORM = {
  titlePrefix: { zh: "请在浏览器中完成：", en: "Finish in the browser: " },
  label: { zh: "完成", en: "Done" },
  done: { zh: "完成", en: "Done" },
  cancel: { zh: "取消", en: "Cancel" },
} as const;
