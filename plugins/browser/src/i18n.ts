// The plugin server's text for people (zh and en). zh says 智能体, never 企业 or the Latin "agent".

/** The handoff question's field: on and submitted = 完成, off or dismissed = 取消. */
export const HANDOFF_FORM = {
  label: { zh: "完成", en: "Done" },
  description: {
    zh: "完成后打开开关并提交，浏览器交还智能体；关闭开关提交或关闭此问题即为取消。",
    en: "Turn on and submit when you are done to hand the browser back; submit with it off, or dismiss the question, to cancel.",
  },
} as const;
