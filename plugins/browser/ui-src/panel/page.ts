// The static page of the panel embed (`/ui/browser`): no data, so no token is needed to load it
// (an iframe navigation cannot send Authorization). Text is filled in by panel.ts from i18n.ts;
// the `--cb-*` design tokens come from the host's `init` / `theme` messages.

export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Browser</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; flex-direction: column; overflow: hidden;
    background: var(--cb-bg, Canvas); color: var(--cb-ink, CanvasText);
    font: 12px/1.4 var(--cb-font, ui-monospace, monospace);
  }
  [hidden] { display: none !important; }
  button, input {
    font: inherit; color: inherit; background: transparent;
    border: 1px solid var(--cb-line-strong, GrayText); padding: 2px 8px; min-height: 26px;
  }
  button:hover:not(:disabled) { background: var(--cb-hover, transparent); }
  button:disabled { opacity: .5; }
  button.primary { background: var(--cb-accent, Highlight); color: var(--cb-on-accent, HighlightText); border-color: transparent; }
  #tabs { display: flex; gap: 2px; overflow-x: auto; padding: 4px 4px 0; border-bottom: 1px solid var(--cb-line, GrayText); }
  .tab { display: flex; align-items: center; max-width: 160px; border: 1px solid var(--cb-line, GrayText); border-bottom: 0; padding: 0 4px 0 8px; gap: 4px; min-height: 26px; }
  .tab[data-active="true"] { background: var(--cb-panel, Canvas); font-weight: 600; }
  .tab button { border: 0; padding: 0 4px; min-height: 22px; }
  .tab .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; text-align: left; padding: 0; }
  #bar { display: flex; gap: 4px; padding: 4px; align-items: center; }
  #url { flex: 1; min-width: 0; }
  #lock { display: inline-flex; color: var(--cb-muted, GrayText); }
  #status { color: var(--cb-muted, GrayText); padding: 0 8px 4px; min-height: 18px; }
  #status[data-control="user"] { color: var(--cb-accent, Highlight); }
  #stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: var(--cb-panel, Canvas); position: relative; overflow: hidden; }
  #view { background: #fff; outline: none; display: block; }
  #view:focus-visible { outline: 2px solid var(--cb-accent, Highlight); }
  #flash { position: absolute; width: 24px; height: 24px; margin: -12px 0 0 -12px; border: 2px solid var(--cb-accent, Highlight); border-radius: 50%; pointer-events: none; }
  .strip { display: flex; gap: 8px; align-items: center; padding: 4px 8px; border-top: 1px solid var(--cb-line, GrayText); background: var(--cb-panel, Canvas); }
  .strip span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center; text-align: center; padding: 16px; background: var(--cb-bg, Canvas); }
  .center h2 { margin: 0; font-size: 13px; }
  .center p { margin: 0; color: var(--cb-muted, GrayText); }
</style>
</head>
<body>
<div id="tabs" role="tablist"></div>
<div id="bar">
  <button type="button" id="back"></button>
  <button type="button" id="forward"></button>
  <button type="button" id="reload"></button>
  <span id="lock" role="img" hidden><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5" width="8" height="6" fill="currentColor"/><path d="M4 5V3.5a2 2 0 0 1 4 0V5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></span>
  <input id="url" type="text" spellcheck="false" autocomplete="off">
  <button type="button" id="takeover" class="primary"></button>
  <button type="button" id="handback" class="primary" hidden></button>
</div>
<div id="handoff" class="strip" hidden><p><span id="handoff-label"></span> <span id="handoff-message"></span></p><button type="button" id="handoff-done" class="primary"></button><button type="button" id="handoff-cancel"></button></div>
<p id="status" role="status"></p>
<div id="stage">
  <canvas id="view" tabindex="0"></canvas>
  <div id="flash" hidden></div>
  <div id="empty" class="center" hidden>
    <h2 id="empty-title"></h2>
    <p id="empty-body"></p>
    <button type="button" id="reconnect"></button>
  </div>
</div>
<div id="blocked" class="strip" hidden><p><span id="blocked-label"></span> <span id="blocked-host"></span></p><button type="button" id="allow" class="primary"></button></div>
<div id="dialog" class="strip" hidden><p><span id="dialog-label"></span> <span id="dialog-text"></span></p></div>
<div id="notice" class="strip" role="alert" hidden><p><span id="notice-text"></span></p></div>
<script src="panel.js"></script>
</body>
</html>
`;
