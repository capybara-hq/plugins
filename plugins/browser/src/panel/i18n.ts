// The panel's strings (zh and en). zh says 智能体, never 企业 or the Latin word "agent".

export const STRINGS = {
  en: {
    title: "Browser",
    back: "Back",
    forward: "Forward",
    reload: "Reload",
    address: "Address",
    newTab: "New tab",
    closeTab: "Close tab",
    takeover: "Take over",
    handback: "Hand back to the agent",
    takeoverHint: "You are controlling the browser. Press Esc to hand it back.",
    statusAgent: "The agent is using the browser",
    statusUser: "You are controlling the browser",
    statusUserElsewhere: "You are controlling the browser from another view",
    statusLoading: "Loading…",
    statusConnecting: "Connecting…",
    blocked: "Blocked by the network setting:",
    allow: "Allow",
    dialog: "The page shows a dialog:",
    emptyTitle: "The browser is not running",
    emptyBody: "It starts when the agent first uses a browser tool.",
    offlineTitle: "The device is offline",
    offlineBody: "The live view needs the device that runs the browser.",
    errorTitle: "The live view stopped",
    errorBody: "The frame was too large or the connection failed.",
    reconnect: "Reconnect",
    view: "Browser view",
  },
  zh: {
    title: "浏览器",
    back: "后退",
    forward: "前进",
    reload: "刷新",
    address: "地址",
    newTab: "新标签页",
    closeTab: "关闭标签页",
    takeover: "接管",
    handback: "交还智能体",
    takeoverHint: "你正在控制浏览器。按 Esc 交还给智能体。",
    statusAgent: "智能体正在使用浏览器",
    statusUser: "你正在控制浏览器",
    statusUserElsewhere: "你正在另一个视图中控制浏览器",
    statusLoading: "加载中…",
    statusConnecting: "正在连接…",
    blocked: "被网络设置拦截：",
    allow: "允许",
    dialog: "页面弹出了对话框：",
    emptyTitle: "浏览器尚未运行",
    emptyBody: "智能体第一次使用浏览器工具时会启动它。",
    offlineTitle: "设备已离线",
    offlineBody: "实时画面需要运行浏览器的设备在线。",
    errorTitle: "实时画面已中断",
    errorBody: "画面过大或连接失败。",
    reconnect: "重新连接",
    view: "浏览器画面",
  },
} as const;

export type Locale = keyof typeof STRINGS;
export type StringKey = keyof (typeof STRINGS)["en"];

export function t(locale: Locale, key: StringKey): string {
  return STRINGS[locale][key];
}
