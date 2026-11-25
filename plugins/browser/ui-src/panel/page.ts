// The static page of the panel embed (`/ui/browser`): no data, so no token is needed to load it
// (an iframe navigation cannot send Authorization). Text is filled in by panel.ts from i18n.ts;
// the `--cb-*` design tokens come from the host's `init` / `theme` messages.
//
// Design (browser panel design, 2026-11-25): the host's panel is the one box; the tab strip, the
// toolbar, the status line and the picture are separated by space and ground, never by borders.
// The first paint is the final layout: fixed bar heights, inline icons, a reserved takeover slot.
// Until everything is ready (the host's init, the browser's state and its first frame) the whole
// panel is one skeleton (`#skeleton`) and nothing else; then it switches once to the live panel.
// The picture is contained and centred on a neutral ground; while the person is in control it
// wears a 2 px accent ring. The takeover button is there at every width: narrow panels merge the
// tabs and the address into one button and move forward / reload into a menu.

/** Inline icons (stroke `currentColor`), shared by the page and the panel script. */
export const ICONS = {
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  forward:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  reload:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  close:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  lock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  more: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  spin: '<svg class="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9"/></svg>',
  dot: '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>',
  hand: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11V5a2 2 0 0 1 4 0v6"/><path d="M13 10V8a2 2 0 0 1 4 0v5a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 5 17.5L4 15a2 2 0 0 1 3.4-2L9 15"/></svg>',
  pause:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
} as const;

const bone = (style: string) => `<span class="bone" style="${style}"></span>`;

export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Browser</title>
<style>
  :root {
    color-scheme: light;
    --ground: color-mix(in srgb, var(--cb-ink, #1A1A18) 5%, var(--cb-bg, #FAF9F6));
    --frame-shadow: 0 1px 2px rgba(26,26,24,.06), 0 4px 16px rgba(26,26,24,.06);
    --bone: color-mix(in srgb, var(--cb-ink, #1A1A18) 7%, transparent);
    --radius: 6px;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --ground: var(--cb-bg, #0A0A0A);
    --frame-shadow: 0 0 0 1px rgba(255,255,255,.08);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; position: relative; overflow: hidden;
    background: var(--cb-panel-2, Canvas); color: var(--cb-ink, CanvasText);
    font-family: var(--cb-font, ui-monospace, "SF Mono", Menlo, monospace);
    font-size: var(--cb-type-body-size, 13px); line-height: var(--cb-type-body-line, 20px);
  }
  /* nothing before the host's tokens and language (init) */
  body:not([data-ready]) { visibility: hidden; }
  [hidden] { display: none !important; }
  button, input { font: inherit; color: inherit; margin: 0; }
  button {
    display: inline-grid; place-items: center; flex: none; height: 28px; min-width: 28px;
    padding: 0; border: 0; border-radius: var(--radius); background: transparent; cursor: pointer;
    white-space: nowrap;
  }
  button:hover:not(:disabled) { background: var(--cb-hover, rgba(26,26,24,.04)); }
  button:disabled { color: var(--cb-disabled, GrayText); cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--cb-focus-ring, Highlight); outline-offset: 1px; }
  .primary, .secondary, .outline { padding: 0 14px; font-weight: 600; }
  .primary { background: var(--cb-accent, #CC4609); color: var(--cb-on-accent, #fff); }
  .primary:hover:not(:disabled) { background: var(--cb-accent-hover, var(--cb-accent, #CC4609)); }
  .secondary { font-weight: 400; box-shadow: inset 0 0 0 1px var(--cb-line, #D9D8D2); }
  .outline { padding: 0 12px; color: var(--cb-accent, #CC4609); box-shadow: inset 0 0 0 1px var(--cb-accent, #CC4609); }

  .layer { position: absolute; inset: 0; display: flex; flex-direction: column; }
  #app[data-loading] { visibility: hidden; }
  .row { flex: none; display: flex; align-items: center; padding: 0 12px; }

  /* tab strip */
  #tabs { height: 32px; align-items: stretch; gap: 2px; overflow-x: auto; scrollbar-width: none; }
  .tab { display: flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 64px; max-width: 200px; padding: 0 10px; color: var(--cb-muted, #5E5E5A); }
  .tab[data-active="true"] { color: var(--cb-ink, #1A1A18); font-weight: 500; box-shadow: inset 0 -2px 0 var(--cb-accent, #CC4609); padding-right: 6px; }
  .fav { width: 14px; height: 14px; border-radius: 3px; flex: none; background: var(--cb-line-soft, #E8E7E2); }
  .tab[data-active="true"] .fav { background: var(--cb-line, #D9D8D2); }
  .tab .label { flex: 1; min-width: 0; display: block; height: auto; text-align: left; overflow: hidden; text-overflow: ellipsis; font-weight: inherit; }
  .tab .label:hover:not(:disabled) { background: transparent; }
  .tab .label:disabled { color: inherit; }
  .tab .x { width: 20px; min-width: 20px; height: 20px; border-radius: 4px; color: var(--cb-muted, #5E5E5A); }
  #tabs .add { align-self: center; color: var(--cb-muted, #5E5E5A); }

  /* toolbar */
  #bar { height: 44px; gap: 4px; }
  #field { flex: 1 1 0; min-width: 0; height: 28px; margin-left: 4px; position: relative; display: flex; align-items: center; border-radius: var(--radius); background: var(--cb-hover, rgba(26,26,24,.05)); }
  #field[data-edit] { background: var(--cb-panel, #fff); box-shadow: inset 0 0 0 1px var(--cb-line, #D9D8D2); }
  #lock { display: inline-flex; flex: none; margin-left: 10px; color: var(--cb-muted, #5E5E5A); }
  #url { flex: 1; min-width: 0; height: 100%; padding: 0 10px 0 6px; border: 0; outline: 0; background: transparent; color: transparent; caret-color: var(--cb-ink, #1A1A18); text-overflow: ellipsis; }
  #lock[hidden] + #url, #lock[hidden] ~ #urltext { padding-left: 10px; }
  #url:focus { color: var(--cb-ink, #1A1A18); }
  #urltext { position: absolute; inset: 0 10px 0 26px; display: flex; align-items: center; pointer-events: none; white-space: nowrap; overflow: hidden; }
  #lock[hidden] ~ #urltext { left: 10px; padding-left: 0; }
  #urltext span:first-child { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  #urltext span:last-child { color: var(--cb-muted, #5E5E5A); overflow: hidden; text-overflow: ellipsis; }
  #url:focus ~ #urltext { visibility: hidden; }
  #takeover, #handback { margin-left: 4px; }
  /* the takeover slot is always reserved: gone only when hand back takes its place */
  #takeover[hidden]:not([data-gone]) { display: inline-grid !important; visibility: hidden; }
  #tabsbtn { flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 0 8px; background: var(--cb-hover, rgba(26,26,24,.05)); text-align: left; }
  #tabsbtn .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  #tabsbtn .count { min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--cb-line-strong, #B5B5AE); font-size: 11px; line-height: 18px; text-align: center; color: var(--cb-muted, #5E5E5A); }
  #tabsbtn, #more { display: none; }
  @media (max-width: 440px) {
    #tabs, #forward, #reload, #field { display: none; }
    #tabsbtn { display: flex; }
    #more { display: inline-grid; color: var(--cb-muted, #5E5E5A); }
  }

  /* status line: one fixed-height line */
  #status { height: 24px; gap: 6px; margin: 0; padding: 0 16px; font-size: var(--cb-type-micro-size, 11px); line-height: var(--cb-type-micro-line, 14px); color: var(--cb-muted, #5E5E5A); white-space: nowrap; overflow: hidden; }
  #status .ico { display: inline-flex; flex: none; }
  #status .lead { flex: none; }
  #status .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  #status[data-tone="agent"] .ico, #status[data-tone="agent"] .lead { color: var(--cb-accent, #CC4609); }
  #status[data-tone="user"] .ico, #status[data-tone="user"] .lead { color: var(--cb-ink, #1A1A18); }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* needs the person: a warn strip in the status line's place */
  .warn { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px 8px 16px; background: color-mix(in srgb, var(--cb-warn, #8F6500) 8%, transparent); }
  .warn > .ico { display: inline-flex; flex: none; color: var(--cb-warn, #8F6500); }
  .warn .text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .warn .title { color: var(--cb-warn, #8F6500); font-weight: 500; overflow-wrap: anywhere; }
  .warn .body { font-family: var(--cb-font-prose, system-ui, sans-serif); color: var(--cb-muted, #5E5E5A); overflow-wrap: anywhere; }
  .warn .actions { display: flex; gap: 6px; flex: none; }

  /* the picture, contained and centred on a neutral ground */
  #stage { flex: 1; min-height: 0; position: relative; display: flex; align-items: center; justify-content: center; padding: 12px; overflow: hidden; background: var(--ground); }
  #view { display: block; flex: none; border-radius: var(--radius); background: #fff; box-shadow: var(--frame-shadow); outline: none; }
  #stage[data-control="user"] #view { box-shadow: 0 0 0 2px var(--cb-accent, #CC4609), 0 4px 16px rgba(26,26,24,.08); }
  #view:focus-visible { box-shadow: 0 0 0 2px var(--cb-focus-ring, Highlight), var(--frame-shadow); }
  #flash { position: absolute; width: 24px; height: 24px; margin: -12px 0 0 -12px; border: 2px solid var(--cb-accent, #CC4609); border-radius: 50%; pointer-events: none; }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center; padding: 16px; text-align: center; background: var(--cb-panel-2, Canvas); }
  .center h2 { margin: 0; font-size: inherit; font-weight: 600; }
  .center p { margin: 0; font-family: var(--cb-font-prose, system-ui, sans-serif); color: var(--cb-muted, #5E5E5A); }
  .center button { margin-top: 6px; }
  /* short-lived notices float over the picture's bottom edge: they never move it */
  #strips { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
  .strip { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px; pointer-events: auto; border-radius: var(--cb-radius-md, 8px); background: var(--cb-raised, #fff); box-shadow: var(--cb-shadow-float, 0 8px 24px rgba(26,26,24,.08)), 0 0 0 1px var(--cb-line-soft, #E8E7E2); }
  .strip p { flex: 1; min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .strip .label { color: var(--cb-muted, #5E5E5A); }
  .strip:not(:has(button)) { padding-right: 12px; }

  /* menus (narrow: tabs, more) */
  .menu { position: absolute; z-index: 2; min-width: 180px; max-width: calc(100% - 24px); max-height: 60%; overflow: auto; padding: 4px; border-radius: var(--cb-radius-md, 8px); background: var(--cb-raised, #fff); box-shadow: var(--cb-shadow-float, 0 8px 24px rgba(26,26,24,.08)), 0 0 0 1px var(--cb-line-soft, #E8E7E2); }
  .menu button { display: flex; width: 100%; justify-content: flex-start; gap: 8px; padding: 0 8px; text-align: left; overflow: hidden; text-overflow: ellipsis; }
  .menu button[aria-current="true"] { font-weight: 600; }

  /* the skeleton: the panel's own shape, quietly pulsing */
  .bone { display: block; flex: none; border-radius: 2px; background: var(--bone); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .5; } }
  #skeleton .shot { width: 100%; max-height: 100%; aspect-ratio: 16 / 10; display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: var(--radius); background: var(--cb-panel, #fff); box-shadow: 0 1px 2px rgba(26,26,24,.06); }
  :root[data-theme="dark"] #skeleton .shot { background: var(--cb-raised, #141413); box-shadow: var(--frame-shadow); }
  #skeleton .narrow { display: none; }
  @media (max-width: 440px) {
    #skeleton .wide { display: none; }
    #skeleton .narrow { display: block; }
  }
  @media (prefers-reduced-motion: reduce) { .bone, .spin { animation: none; } }
</style>
</head>
<body>
<div id="skeleton" class="layer" aria-busy="true">
  <div class="row wide" style="height:32px;gap:8px;padding:0 22px;display:flex">${bone("width:14px;height:14px;border-radius:3px")}${bone("width:96px;height:10px")}</div>
  <div class="row" style="height:44px;gap:4px">${bone("width:28px;height:28px;border-radius:6px")}<span class="wide" style="display:contents">${bone("width:28px;height:28px;border-radius:6px")}${bone("width:28px;height:28px;border-radius:6px")}</span>${bone("flex:1;height:28px;margin-left:4px;border-radius:6px")}${bone("width:56px;height:28px;margin-left:4px;border-radius:6px")}</div>
  <p id="skeleton-status" class="row" role="status" style="height:24px;margin:0;padding:0 16px;font-size:11px;line-height:14px;color:var(--cb-muted,#5E5E5A)"></p>
  <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:12px;background:var(--ground)">
    <div class="shot">${bone("width:40%;height:12px")}${bone("width:75%;height:10px")}${bone("width:60%;height:10px")}${bone("flex:1;border-radius:4px")}</div>
  </div>
</div>
<div id="app" class="layer" data-loading>
  <div id="tabs" class="row" role="tablist"></div>
  <div id="bar" class="row">
    <button type="button" id="back">${ICONS.back}</button>
    <button type="button" id="forward">${ICONS.forward}</button>
    <button type="button" id="reload">${ICONS.reload}</button>
    <button type="button" id="tabsbtn" aria-haspopup="menu"><span class="fav"></span><span class="name" id="tabsbtn-name"></span><span class="count" id="tabsbtn-count"></span></button>
    <label id="field"><span id="lock" role="img" hidden>${ICONS.lock}</span><input id="url" type="text" spellcheck="false" autocomplete="off"><span id="urltext"><span id="urltext-host"></span><span id="urltext-path"></span></span></label>
    <button type="button" id="more" aria-haspopup="menu">${ICONS.more}</button>
    <button type="button" id="takeover" class="primary" hidden></button>
    <button type="button" id="handback" class="outline" hidden></button>
  </div>
  <p id="status" class="row" role="status"><span class="ico" id="status-icon"></span><span class="lead" id="status-lead"></span><span class="detail" id="status-detail"></span></p>
  <div id="verify" class="warn" hidden><span class="ico">${ICONS.pause}</span><div class="text"><span class="title" id="verify-title"></span><span class="body" id="verify-body"></span></div><div class="actions"><button type="button" id="verify-go" class="primary"></button></div></div>
  <div id="handoff" class="warn" hidden><span class="ico">${ICONS.pause}</span><div class="text"><span class="title" id="handoff-label"></span><span class="body" id="handoff-message"></span></div><div class="actions"><button type="button" id="handoff-done" class="primary"></button><button type="button" id="handoff-cancel" class="secondary"></button></div></div>
  <div id="stage">
    <canvas id="view" tabindex="0"></canvas>
    <div id="flash" hidden></div>
    <div id="empty" class="center" hidden>
      <h2 id="empty-title"></h2>
      <p id="empty-body"></p>
      <button type="button" id="reconnect" class="secondary"></button>
    </div>
    <div id="strips">
      <div id="blocked" class="strip" hidden><p><span id="blocked-label" class="label"></span> <span id="blocked-host"></span></p><button type="button" id="allow" class="primary"></button></div>
      <div id="dialog" class="strip" hidden><p><span id="dialog-label" class="label"></span> <span id="dialog-text"></span></p></div>
      <div id="notice" class="strip" role="alert" hidden><p><span id="notice-text"></span></p></div>
    </div>
  </div>
</div>
<div id="menu" class="menu" role="menu" hidden></div>
<script src="panel.js"></script>
</body>
</html>
`;
