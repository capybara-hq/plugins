// Verification pages (bot checks, CAPTCHAs): recognised so the agent hands the page to the person
// (browser_handoff) instead of trying to solve it or hopping between sites, and so the panel can
// show "需要你完成验证". Recognition only: nothing here solves, hides or works around a check.

import type { Page } from "playwright-core";

/** What a tab shows when a verification page blocks it (ViewerTab.blocker, stable for the panel). */
export interface TabBlocker {
  kind: "verification";
  /** The page that asks for the verification. */
  url: string;
}

/** The note a tool result starts with while the active tab shows a verification page. */
export const VERIFICATION_NOTE =
  "This page is a verification (CAPTCHA or bot check) page. Do not try to solve it and do not switch to another site to get around it: call browser_handoff and ask the user to complete the verification, then continue.";

/** URL parts of verification pages: generic words and the well-known challenge paths. */
const URL_RE =
  /captcha|challenge|antispider|anti-spider|\/sorry\/|wappass\.baidu\.com|\/cdn-cgi\/|\/verify(?:[/?#]|$)|security-?check/i;

/** Titles of verification pages, English and Chinese. */
const TITLE_RE =
  /captcha|verif(?:y|ication)|are you (?:a )?(?:human|robot)|not a robot|just a moment|attention required|security check|unusual traffic|人机验证|安全验证|验证码|请完成验证|访问验证|异常访问|身份验证|滑动验证|拖动滑块/i;

/** Main-document statuses a site answers automated traffic with (418: DuckDuckGo, 429: rate limit). */
export const VERIFICATION_STATUSES = new Set([418, 429]);

/** Runs in the page (a string: the daemon compiles without the DOM types): a visible widget. */
const WIDGET_PROBE = `(() => {
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 20; };
  const frames = [...document.querySelectorAll("iframe")].filter((f) =>
    /recaptcha|hcaptcha|challenges\\.cloudflare\\.com|turnstile|geetest|captcha/i.test(f.src));
  if (frames.some(visible)) return true;
  return [...document.querySelectorAll("[id*=captcha i], [class*=captcha i]")].some(visible);
})()`;

/** Whether `url` and `title` alone mark a verification page. */
export function looksLikeVerification(url: string, title: string): boolean {
  let target = url;
  try {
    const u = new URL(url);
    target = `${u.hostname}${u.pathname}${u.search}`;
  } catch {
    // not a URL: test it as is
  }
  return URL_RE.test(target) || TITLE_RE.test(title);
}

/**
 * Whether the page is a verification page: its URL or title, the status its document came with
 * ({@link VERIFICATION_STATUSES}), or a visible CAPTCHA widget in it (an iframe of a CAPTCHA
 * provider, an element whose id or class names a captcha). Never throws (false when unsure).
 */
export async function isVerificationPage(page: Page, status?: number): Promise<boolean> {
  try {
    if (status !== undefined && VERIFICATION_STATUSES.has(status)) return true;
    const url = page.url();
    if (!/^https?:/.test(url)) return false;
    if (looksLikeVerification(url, await page.title())) return true;
    return (await page.evaluate(WIDGET_PROBE)) === true;
  } catch {
    return false;
  }
}
