import {
  useClientStorage,
  useLocale,
  usePrefersReducedMotion,
  useTheme,
} from "@capybara-hq/plugin-client";
import { type AnimationEvent, useEffect, useState } from "react";
import { BOOT_KEY, cx, THEME_KEY, WORDMARK } from "./shared.js";

/** The boot screen's own exit animation (plugin CSS); its end removes the screen. */
export const BOOT_OUT_ANIMATION = "cx-theme-cyberpunk-boot-out";

/**
 * How long the boot screen may stay at most (ms), whatever the CSS does: it never outlives this
 * even when the stylesheet is missing.
 */
export const BOOT_MAX_MS = 2400;

/** `shell.overlay`: CRT scanlines and a vignette, decorative only (no pointer events, aria-hidden). */
export function Scanlines() {
  const { key } = useTheme();
  if (key !== THEME_KEY) return null;
  return <div aria-hidden="true" className={cx("scanlines")} />;
}

/** The boot lines, in order (status text only; never content a person needs). */
function bootLines(t: (text: { en: string; zh: string }) => string): string[] {
  return [
    `${WORDMARK} OS v0.1 · ${t({ en: "cold start", zh: "冷启动" })}`,
    `${t({ en: "neural link", zh: "神经链路" })} ........ [ OK ]`,
    `${t({ en: "optic overlay", zh: "视觉叠层" })} ...... [ OK ]`,
    `${t({ en: "agent uplink", zh: "智能体上行" })} ....... [ OK ]`,
    `${t({ en: "audio bus (muted)", zh: "音频总线（静音）" })} .. [ OK ]`,
    `${t({ en: "welcome back, operator", zh: "欢迎回来，操作员" })}`,
  ];
}

/**
 * The boot screen itself: plays once per browser session (session client storage), never under
 * reduced motion. It never blocks input: the decoration layer and the screen take no pointer
 * events, it ends by itself after about 1.9 s (at most {@link BOOT_MAX_MS}), and Skip or Escape
 * ends it at once.
 */
export function BootScreen() {
  const storage = useClientStorage();
  const reducedMotion = usePrefersReducedMotion();
  const { t } = useLocale();
  const [show, setShow] = useState(
    () => !reducedMotion && storage.get(BOOT_KEY, "session") === null,
  );

  // Mark the session first, so a reload during the animation does not replay it.
  useEffect(() => {
    if (show) storage.set(BOOT_KEY, "1", "session");
  }, [show, storage]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShow(false);
    };
    window.addEventListener("keydown", onKey);
    // A deadline independent of the stylesheet (animation frames, no timers).
    let frame = 0;
    let started: number | undefined;
    const tick = (now: number) => {
      started ??= now;
      if (now - started >= BOOT_MAX_MS) setShow(false);
      else frame = window.requestAnimationFrame(tick);
    };
    if (typeof window.requestAnimationFrame === "function") {
      frame = window.requestAnimationFrame(tick);
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
    };
  }, [show]);

  if (!show || reducedMotion) return null;
  const onAnimationEnd = (e: AnimationEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && e.animationName === BOOT_OUT_ANIMATION) setShow(false);
  };
  return (
    <div className={cx("boot")} onAnimationEnd={onAnimationEnd}>
      <div aria-hidden="true" className={cx("boot-screen")}>
        <div className={cx("boot-head")}>
          <span>{`${WORDMARK} // BOOT`}</span>
          <span>TTY-01</span>
        </div>
        {bootLines(t).map((line) => (
          <div key={line} className={cx("boot-line")}>
            {line}
          </div>
        ))}
        <div className={cx("boot-track")}>
          <div className={cx("boot-bar")} />
        </div>
      </div>
      <button
        type="button"
        data-cap-interactive=""
        className={cx("boot-skip")}
        aria-label={t({ en: "Skip the boot animation", zh: "跳过启动动画" })}
        onClick={() => setShow(false)}
      >
        {t({ en: "Skip", zh: "跳过" })} [Esc]
      </button>
    </div>
  );
}

/** `shell.overlay`: the boot screen, only while the theme is active. */
export function Boot() {
  const { key } = useTheme();
  return key === THEME_KEY ? <BootScreen /> : null;
}
