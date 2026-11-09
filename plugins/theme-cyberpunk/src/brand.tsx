import { type ComponentProps, Logo, useLocale, useTheme } from "@capybara-hq/plugin-client";
import type { ReactNode } from "react";
import { cx, THEME_KEY, WORDMARK } from "./shared.js";

/**
 * Text with two offset colour layers that jump now and then (the glitch). The base text is the
 * readable one; the layers are copies hidden from assistive tech. The animation is plugin CSS and
 * stops under reduced motion.
 */
export function Glitch({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className === undefined ? cx("glitch") : `${cx("glitch")} ${className}`}>
      <span className={cx("glitch-base")}>{text}</span>
      <span aria-hidden="true" className={`${cx("glitch-layer")} ${cx("glitch-a")}`}>
        {text}
      </span>
      <span aria-hidden="true" className={`${cx("glitch-layer")} ${cx("glitch-b")}`}>
        {text}
      </span>
    </span>
  );
}

/** Which sidebar panel the brand is drawn in (the host may pass `panel`; else `collapsed` decides). */
export function brandPanel(props: { collapsed: boolean; panel?: unknown }): "rail" | "full" {
  if (props.panel === "rail") return "rail";
  if (props.panel === "full" || props.panel === "drawer") return "full";
  return props.collapsed ? "rail" : "full";
}

/**
 * The cyberpunk brand: in the full sidebar (and the drawer) the theme's neon mark and a glitch
 * `CYBERBARA` wordmark; in the rail the built-in mark with a flicker. One node per drawn panel.
 */
export function GlitchBrand({ panel, builtin }: { panel: "rail" | "full"; builtin: ReactNode }) {
  if (panel === "rail") {
    return <span className={`${cx("brand")} ${cx("brand-rail")}`}>{builtin}</span>;
  }
  return (
    <span className={cx("brand")} role="img" aria-label={WORDMARK}>
      <span aria-hidden="true" className={cx("brand-mark")}>
        <Logo scale={2} wordmark={false} />
      </span>
      <span aria-hidden="true">
        <Glitch text={WORDMARK} className={cx("brand-word")} />
      </span>
    </span>
  );
}

/** `shell.brand` replacement: the glitch brand while the theme is active, else the built-in. */
export function Brand(props: ComponentProps<"shell.brand">) {
  const { key } = useTheme();
  if (key !== THEME_KEY) return <>{props.builtin}</>;
  return <GlitchBrand panel={brandPanel(props)} builtin={props.builtin} />;
}

/** The cyberpunk new-conversation hero: the big neon capybara, a status line and the greeting. */
export function CyberHero({ greeting }: { greeting: string }) {
  const { t } = useLocale();
  return (
    <div className={cx("hero")}>
      <div aria-hidden="true" className={cx("hero-mark")}>
        <Logo scale={6} wordmark={false} />
      </div>
      <p aria-hidden="true" className={cx("hero-kicker")}>
        {`// ${WORDMARK} · ${t({ en: "NEURAL LINK ESTABLISHED", zh: "神经链路已接通" })}`}
      </p>
      <h1 className={cx("hero-title")}>
        <Glitch text={greeting} />
      </h1>
      <p className={cx("hero-sub")}>
        {t({ en: "Jack in: type below to start.", zh: "已接入：在下方输入，开始对话。" })}
      </p>
    </div>
  );
}

/** `conversation.empty` replacement: the cyberpunk hero while the theme is active, else the built-in. */
export function Hero(props: ComponentProps<"conversation.empty">) {
  const { key } = useTheme();
  if (key !== THEME_KEY) return <>{props.builtin}</>;
  return <CyberHero greeting={props.greeting} />;
}
