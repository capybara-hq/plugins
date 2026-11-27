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

/**
 * A parked long wait's question (browser long waits spec §6.1): what the agent waits for, and
 * one button that ends the wait.
 */
export const WAIT_FORM = {
  titlePrefix: { zh: "智能体正在等待：", en: "The agent is waiting until " },
  end: { zh: "结束等待", en: "End the wait" },
  endButton: { zh: "结束等待", en: "End wait" },
  /** What the condition is, per kind (the text, ref or URL part follows where it has one). */
  text: { zh: "页面出现", en: "the page shows " },
  ref: { zh: "元素出现 ", en: "element appears: " },
  urlContains: { zh: "网址包含", en: "the URL contains " },
  navigation: { zh: "页面完成跳转", en: "the page navigates" },
  download: { zh: "下载完成", en: "a download finishes" },
} as const;
