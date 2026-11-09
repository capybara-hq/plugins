import {
  Button,
  type CapybaraEvent,
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
import { useState } from "react";
import { cx, parseHudData, SOUND_KEY } from "./shared.js";
import { playCue } from "./sound.js";

type Label = { en: string; zh: string };

const STATE_LABEL: Record<RunState, Label> = {
  idle: { en: "STANDBY", zh: "待命" },
  running: { en: "RUNNING", zh: "运行中" },
  waiting: { en: "AWAITING INPUT", zh: "等待输入" },
  failed: { en: "FAULT", zh: "故障" },
};

// capybara:allow-module-state read-only constant: the client events the HUD counts
const HUD_EVENTS: readonly CapybaraEventType[] = [
  "run.started",
  "tool.finished",
  "approval.requested",
];

/** What the HUD counted on this page for the open conversation (client events since it opened). */
interface Counts {
  runs: number;
  tools: number;
  errors: number;
  approvals: number;
}

const ZERO: Counts = { runs: 0, tools: 0, errors: 0, approvals: 0 };

/** The counts after one client event. */
function count(c: Counts, e: CapybaraEvent): Counts {
  if (e.type === "run.started") return { ...c, runs: c.runs + 1 };
  if (e.type === "approval.requested") return { ...c, approvals: c.approvals + 1 };
  if (e.type === "tool.finished") {
    return e.isError ? { ...c, errors: c.errors + 1 } : { ...c, tools: c.tools + 1 };
  }
  return c;
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
 * tool and approval counts since the page opened, and the sound toggle (off by default, stored in
 * local client storage). Its colours follow the run state through the plugin CSS
 * (`[data-cap-state~="run=…"]`), only while the cyberpunk theme is active.
 */
export function RunHud({ conversationId }: ComponentProps<"conversation.properties.section">) {
  const { state } = useRunState();
  const { view, status, retry } = useView();
  const { t } = useLocale();
  const storage = useClientStorage();
  const reducedMotion = usePrefersReducedMotion();
  const [sound, setSound] = useState(() => storage.get(SOUND_KEY) === "on");
  // Counts belong to the conversation they were counted for.
  const [counted, setCounted] = useState<{ conversationId: string; counts: Counts }>({
    conversationId,
    counts: ZERO,
  });
  const counts = counted.conversationId === conversationId ? counted.counts : ZERO;

  useCapybaraEvents((e) => {
    if (e.conversationId !== conversationId) return;
    setCounted((prev) => {
      const c = prev.conversationId === conversationId ? prev.counts : ZERO;
      return { conversationId, counts: count(c, e) };
    });
  }, HUD_EVENTS);

  const toggleSound = () => {
    const next = !sound;
    storage.set(SOUND_KEY, next ? "on" : null);
    setSound(next);
    if (next && !reducedMotion) playCue("on");
  };

  const data = parseHudData(view?.data);
  const pending = t({ en: "syncing…", zh: "同步中…" });
  const offline = t({ en: "offline", zh: "离线" });
  const serverValue = (v: string | null | undefined) =>
    status === "failed" ? offline : v === null || v === undefined ? pending : v;

  return (
    <div className={cx("hud")}>
      <div className={cx("hud-status")}>
        <span aria-hidden="true" className={cx("hud-dot")} />
        <span className={cx("hud-state")}>{t(STATE_LABEL[state])}</span>
      </div>
      <div aria-hidden="true" className={cx("hud-meter")}>
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
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
            v: serverValue(data?.operator.toUpperCase()),
          },
          {
            k: t({ en: "Uplink", zh: "上行链路" }),
            v: serverValue(data === null ? null : clock(data.uplink)),
          },
          {
            k: t({ en: "Runs", zh: "运行" }),
            v: String(counts.runs),
          },
          {
            k: t({ en: "Tools", zh: "工具调用" }),
            v: t({
              en: `${counts.tools} ok / ${counts.errors} err`,
              zh: `${counts.tools} 成功 / ${counts.errors} 出错`,
            }),
          },
          {
            k: t({ en: "Approvals", zh: "审批" }),
            v: String(counts.approvals),
          },
        ]}
      />
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
