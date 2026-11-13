import type { MemoryType } from "./graph.js";

/**
 * The memory page's copy, zh and en. The zh copy says 智能体, never the Latin word for agent.
 * The delete confirmation is the spec's text (§6.5), verbatim.
 */

export type Locale = "zh" | "en";
export interface Copy {
  zh: string;
  en: string;
}

export const DELETE_CONFIRM: Copy = {
  zh: "已删除的记忆不会再出现在新的索引里，但之前对话中已出现的内容仍保留在那些对话的记录中。",
  en: "Deleted memories no longer appear in new indexes, but what earlier conversations already showed stays in those conversations' records.",
};

export const TYPE_LABEL: Record<MemoryType, Copy> = {
  user: { zh: "用户", en: "User" },
  feedback: { zh: "反馈", en: "Feedback" },
  project: { zh: "项目", en: "Project" },
  reference: { zh: "参考", en: "Reference" },
};

export const COPY = {
  agent: { zh: "智能体", en: "Agent" },
  member: { zh: "成员", en: "Member" },
  search: { zh: "搜索记忆", en: "Search memories" },
  clearSearch: { zh: "清除搜索", en: "Clear search" },
  noHits: { zh: "没有找到相关的记忆。", en: "No matching memories." },
  graph: { zh: "图谱", en: "Graph" },
  list: { zh: "列表", en: "List" },
  view: { zh: "显示方式", en: "View" },
  fit: { zh: "适配视图", en: "Fit to view" },
  loading: { zh: "正在载入记忆…", en: "Loading memories…" },
  failed: { zh: "记忆载入失败。", en: "Could not load the memories." },
  retry: { zh: "重试", en: "Retry" },
  noAccess: { zh: "只有组织成员可以查看记忆。", en: "Only org members can see memories." },
  emptyTitle: { zh: "还没有记忆", en: "No memories yet" },
  emptyBody: {
    zh: "智能体在一对一对话中记下关于你的事情后，会出现在这里。",
    en: "When an agent remembers something about you in a one-to-one conversation, it shows up here.",
  },
  emptyAgent: {
    zh: "这个智能体还没有关于你的记忆。",
    en: "This agent has no memories about you yet.",
  },
  emptyOther: {
    zh: "这位成员和这个智能体之间还没有记忆。",
    en: "This member has no memories with this agent yet.",
  },
  sizeLegend: { zh: "大小：被想起的次数", en: "Size: times recalled" },
  glowLegend: { zh: "亮度：最近一次被想起", en: "Brightness: last recalled" },
  linkLegend: { zh: "实线：记忆里写下的链接", en: "Solid: links written in memories" },
  semanticLegend: { zh: "虚线：语义相近", en: "Dashed: semantically close" },
  hint: {
    zh: "拖动节点 · 拖动空白处平移 · 滚轮缩放 · 方向键逐条浏览",
    en: "Drag nodes · drag the background to pan · scroll to zoom · arrow keys to step through",
  },
  path: { zh: "路径", en: "Path" },
  description: { zh: "描述", en: "Description" },
  body: { zh: "正文", en: "Body" },
  recalled: { zh: "被想起", en: "Recalled" },
  lastRecalled: { zh: "最近想起", en: "Last recalled" },
  never: { zh: "从未", en: "Never" },
  created: { zh: "创建于", en: "Created" },
  updated: { zh: "更新于", en: "Updated" },
  createdIn: { zh: "来自对话", en: "Written in" },
  openConversation: { zh: "打开对话", en: "Open the conversation" },
  links: { zh: "链接", en: "Links" },
  dangling: { zh: "尚未写下", en: "not written yet" },
  edit: { zh: "编辑", en: "Edit" },
  save: { zh: "保存", en: "Save" },
  cancel: { zh: "取消", en: "Cancel" },
  delete: { zh: "删除", en: "Delete" },
  close: { zh: "关闭", en: "Close" },
  confirmTitle: { zh: "删除这条记忆？", en: "Delete this memory?" },
  actionFailed: { zh: "操作没有完成：", en: "The action did not complete: " },
  readOnly: {
    zh: "管理员不能编辑其他成员的记忆。",
    en: "Admins cannot edit another member's memories.",
  },
} satisfies Record<string, Copy>;

export const count = (n: number): Copy => ({
  zh: `${n} 条记忆`,
  en: n === 1 ? "1 memory" : `${n} memories`,
});

export const loadingMore = (n: number, total: number): Copy => ({
  zh: `正在载入 ${n} / ${total}`,
  en: `Loading ${n} of ${total}`,
});

export const times = (n: number): Copy => ({ zh: `${n} 次`, en: n === 1 ? "once" : `${n} times` });

export const adminViewing = (name: string): Copy => ({
  zh: `你正在查看 ${name} 的记忆。每次查看和删除都会记入审计日志；管理员不能编辑其他成员的记忆。`,
  en: `You are viewing ${name}'s memories. Every view and delete is recorded in the audit log; admins cannot edit another member's memories.`,
});

export const canvasLabel = (n: number): Copy => ({
  zh: `记忆图谱，共 ${n} 条记忆。用方向键逐条浏览，回车打开，Esc 关闭。`,
  en: `Memory graph with ${n} memories. Use the arrow keys to step through them, Enter to open one and Escape to close it.`,
});

export const bytesOf = (n: number, max: number): Copy => ({
  zh: `${n} / ${max} 字节`,
  en: `${n} / ${max} bytes`,
});

/** "3 days ago" / "3 天前" (null: never). */
export function relative(iso: string | null, locale: Locale, now = Date.now()): string {
  if (iso === null) return COPY.never[locale];
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return COPY.never[locale];
  const fmt = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto" });
  const s = Math.round((at - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return fmt.format(s, "second");
  if (abs < 3600) return fmt.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return fmt.format(Math.round(s / 3600), "hour");
  if (abs < 86_400 * 30) return fmt.format(Math.round(s / 86_400), "day");
  if (abs < 86_400 * 365) return fmt.format(Math.round(s / (86_400 * 30)), "month");
  return fmt.format(Math.round(s / (86_400 * 365)), "year");
}

/** A date and time in the viewer's language. */
export function dateTime(iso: string, locale: Locale): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(at);
}
