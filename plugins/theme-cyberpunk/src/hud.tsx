import {
  Button,
  type CapybaraEventType,
  type ComponentProps,
  KeyValue,
  type RunState,
  Stack,
  Text,
  useCapybaraEvents,
  useClientStorage,
  useLocale,
  usePrefersReducedMotion,
  useRunState,
  useView,
} from "@capybara-hq/plugin-client";
import { useEffect, useReducer, useState } from "react";
import { readCounts, recordEvent } from "./counts.js";
import { cx, parseHudData, SOUND_KEY } from "./shared.js";
import { playCue } from "./sound.js";

type Label = { en: string; zh: string };

const STATE_LABEL: Record<RunState, Label> = {
  idle: { en: "STANDBY", zh: "待命" },
  running: { en: "RUNNING", zh: "运行中" },
  waiting: { en: "AWAITING INPUT", zh: "等待输入" },
  failed: { en: "FAULT", zh: "故障" },
};

const HUD_EVENTS: readonly CapybaraEventType[] = [
  "run.started",
  "tool.finished",
  "approval.requested",
];

const RUN_START: readonly CapybaraEventType[] = ["run.started"];

/** Shown for a count this browser has not seen anything of yet. */
const NONE = "—";

/** The equalizer bars of the signal meter. */
const BARS = 12;

const ROLE_LABEL: Record<string, Label> = {
  owner: { en: "OWNER", zh: "所有者" },
  admin: { en: "ADMIN", zh: "管理员" },
  member: { en: "MEMBER", zh: "成员" },
  guest: { en: "GUEST", zh: "访客" },
  superAdmin: { en: "SUPER ADMIN", zh: "超级管理员" },
};

/** "T+MM:SS.s" of a duration in milliseconds. */
export function ticker(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100));
  const s = Math.floor(tenths / 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `T+${p(Math.floor(s / 60))}:${p(s % 60)}.${tenths % 10}`;
}

/**
 * The elapsed time of the current run, from its `run.started` event (or from when this panel saw
 * it running), ticking every 100 ms while it runs (every second under reduced motion) and frozen
 * at the last value once it stops. Null before this panel has seen a run. A browser timer of this
 * document only, cleared when the run stops or the panel unmounts.
 */
function useRunClock(state: RunState, startedAt: number | null): number | null {
  const reducedMotion = usePrefersReducedMotion();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (state !== "running" || startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), reducedMotion ? 1000 : 100);
    return () => window.clearInterval(timer);
  }, [state, startedAt, reducedMotion]);
  return startedAt === null || now === null ? null : Math.max(0, now - startedAt);
}

/** "HH:MM:SS" of an ISO time, or null when it does not parse. */
function clock(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * The run HUD (slot `conversation.properties.section`, inside the host's section frame): the open
 * conversation's run state, a signal meter, the server's view data (operator role, last uplink),
 * the elapsed time of the run (a ticker), the runs, tool results and approvals seen live in this
 * browser session ("—" before any), and the sound toggle (off by default, local client storage). Its colours follow the run state through the plugin CSS
 * (`[data-cap-state~="run=…"]`), only while the cyberpunk theme is active.
 */
export function RunHud({ conversationId }: ComponentProps<"conversation.properties.section">) {
  const { state } = useRunState();
  const { view, status, retry } = useView();
  const { t } = useLocale();
  const storage = useClientStorage();
  const reducedMotion = usePrefersReducedMotion();
  const [sound, setSound] = useState(() => storage.get(SOUND_KEY) === "on");
  // Counts live in session client storage, recorded by the extension's listener from the page's
  // first load; the HUD records too (idempotent by seq) and re-reads on each event.
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useCapybaraEvents((e) => {
    recordEvent(storage, e);
    refresh();
  }, HUD_EVENTS);
  const counts = readCounts(storage, conversationId);

  // The run's start: its run.started time, else when this panel first saw it running.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  useCapybaraEvents((e) => {
    if (e.conversationId !== conversationId) return;
    const at = Date.parse(e.at);
    setStartedAt(Number.isNaN(at) ? Date.now() : Math.min(at, Date.now()));
  }, RUN_START);
  useEffect(() => {
    if (state === "running") setStartedAt((s) => s ?? Date.now());
  }, [state]);
  const elapsed = useRunClock(state, startedAt);

  const toggleSound = () => {
    const next = !sound;
    storage.set(SOUND_KEY, next ? "on" : null);
    setSound(next);
    if (next && !reducedMotion) playCue("on");
  };

  const data = parseHudData(view?.data);
  const pending = t({ en: "syncing…", zh: "同步中…" });
  const offline = t({ en: "offline", zh: "离线" });
  const role = (r: string) => {
    const label = ROLE_LABEL[r];
    return label === undefined ? r.toUpperCase() : t(label);
  };
  const serverValue = (v: string | null | undefined) =>
    status === "failed" ? offline : v === null || v === undefined ? pending : v;

  return (
    <div className={cx("hud")}>
      <div className={cx("hud-status")}>
        <span aria-hidden="true" className={cx("hud-dot")} />
        <span className={cx("hud-state")}>{t(STATE_LABEL[state])}</span>
        <span
          className={cx("hud-ticker")}
          title={t({ en: "Time of the current or last run", zh: "本次或上次运行的用时" })}
        >
          {elapsed === null ? "T+--:--.-" : ticker(elapsed)}
        </span>
      </div>
      <div aria-hidden="true" className={cx("hud-meter")}>
        {Array.from({ length: BARS }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of identical bars
          <span key={i} />
        ))}
      </div>
      <KeyValue
        keyWidth="10ch"
        rows={[
          {
            k: t({ en: "Node", zh: "节点" }),
            v: `#${conversationId.slice(-6).toUpperCase()}`,
          },
          {
            k: t({ en: "Operator", zh: "操作员" }),
            v: serverValue(data === null ? null : role(data.operator)),
          },
          {
            k: t({ en: "Uplink", zh: "上行链路" }),
            v: serverValue(data === null ? null : clock(data.uplink)),
          },
          {
            k: t({ en: "Runs", zh: "运行" }),
            v: counts === null ? NONE : String(counts.runs),
          },
          {
            k: t({ en: "Tools", zh: "工具调用" }),
            v:
              counts === null
                ? NONE
                : t({
                    en: `${counts.tools} ok / ${counts.errors} err`,
                    zh: `${counts.tools} 成功 / ${counts.errors} 出错`,
                  }),
          },
          {
            k: t({ en: "Approvals", zh: "审批" }),
            v: counts === null ? NONE : String(counts.approvals),
          },
        ]}
      />
      <Text variant="micro" tone="muted">
        {t({
          en: "Runs, tools and approvals: seen live in this browser tab.",
          zh: "运行、工具调用与审批：本标签页实时看到的次数。",
        })}
      </Text>
      <Stack direction="row" gap={8} align="center" justify="between" wrap>
        <Button
          variant="secondary"
          onClick={toggleSound}
          title={t({
            en: "Short synthesized cues on run start, finish, approvals and tool results",
            zh: "运行开始、结束、审批与工具结果时播放简短的合成提示音",
          })}
        >
          {sound ? t({ en: "Sound: on", zh: "音效：开" }) : t({ en: "Sound: off", zh: "音效：关" })}
        </Button>
        {status === "failed" ? (
          <Button variant="ghost" onClick={retry}>
            {t({ en: "Reconnect", zh: "重新连接" })}
          </Button>
        ) : null}
      </Stack>
      {sound && reducedMotion ? (
        <Text variant="micro" tone="muted">
          {t({
            en: "Muted while your system asks for reduced motion.",
            zh: "系统开启了减少动态效果，音效保持静音。",
          })}
        </Text>
      ) : null}
    </div>
  );
}
