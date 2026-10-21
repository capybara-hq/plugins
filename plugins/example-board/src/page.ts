/**
 * 看板的静态页面与脚本（纯 HTML / JS，不含任何数据，所以不要求令牌：iframe 导航带不了 Authorization 头）。
 * 页面跑在沙箱 iframe 里（不透明源）：令牌、语言、主题与设计 token 都从外层的 `init` 消息拿，
 * 数据经同源代理 `/plugin-ui/example-board/...` 用 `Authorization: Bearer <令牌>` 取。
 * 设计 token（`--cb-*`）由 `init` / `theme` 消息给出，样式里用 `var(--cb-…, 兜底值)`。
 */

export const BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Board</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px;
    background: var(--cb-bg, Canvas); color: var(--cb-ink, CanvasText);
    font: 13px/1.5 var(--cb-font, ui-monospace, monospace);
  }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--cb-muted, GrayText); margin: 0 0 8px; }
  #columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  section { border: 1px solid var(--cb-line, GrayText); background: var(--cb-panel, Canvas); padding: 8px; min-height: 80px; }
  article { border: 1px solid var(--cb-line, GrayText); padding: 6px 8px; margin-bottom: 6px; }
  article p { margin: 0 0 6px; overflow-wrap: anywhere; }
  .moves { display: flex; flex-wrap: wrap; gap: 4px; }
  button, input {
    font: inherit; color: inherit; background: transparent;
    border: 1px solid var(--cb-line-strong, GrayText); padding: 2px 8px;
  }
  button:hover { background: var(--cb-hover, transparent); }
  button.primary { background: var(--cb-accent, Highlight); color: var(--cb-on-accent, HighlightText); border-color: transparent; }
  form { display: flex; gap: 8px; margin-top: 12px; }
  input { flex: 1; min-width: 0; }
  #status { color: var(--cb-muted, GrayText); margin: 0 0 8px; }
  #status[data-tone="warn"] { color: var(--cb-warn, GrayText); }
</style>
</head>
<body>
<main id="app" aria-busy="true">
  <p id="status" role="status"></p>
  <div id="columns"></div>
  <form id="new" hidden>
    <input id="title" name="title" maxlength="200" required>
    <button class="primary" type="submit" id="add"></button>
  </form>
</main>
<script src="board.js"></script>
</body>
</html>
`;

/** 浏览器端脚本（ES5 风格、不用模板字符串，避免与外层 TS 模板字符串冲突）。 */
export const BOARD_JS = `(function () {
  "use strict";
  var PROTOCOL = "capybara-embed/1";
  var STATUSES = ["todo", "doing", "done"];
  var TEXT = {
    en: { todo: "To do", doing: "In progress", done: "Done", add: "Add card", title: "New card title",
          empty: "No cards", move: "Move to", live: "Live",
          lost: "Reconnecting...", failed: "Could not load cards", added: "Card added", loading: "Loading..." },
    zh: { todo: "待办", doing: "进行中", done: "已完成", add: "添加卡片", title: "新卡片标题",
          empty: "没有卡片", move: "移到", live: "实时", lost: "正在重连...",
          failed: "读取卡片失败", added: "已添加卡片", loading: "加载中..." }
  };
  var token = null;
  var locale = "en";
  var started = false;

  function t(key) { return (TEXT[locale] || TEXT.en)[key]; }
  function $(id) { return document.getElementById(id); }
  function post(msg) { msg.protocol = PROTOCOL; window.parent.postMessage(msg, "*"); }
  function setStatus(text, tone) {
    var el = $("status");
    el.textContent = text;
    if (tone) el.setAttribute("data-tone", tone); else el.removeAttribute("data-tone");
  }

  function applyTokens(tokens, theme) {
    var root = document.documentElement;
    if (theme === "dark" || theme === "light") root.setAttribute("data-theme", theme);
    if (!tokens || typeof tokens !== "object") return;
    Object.keys(tokens).forEach(function (name) {
      var value = tokens[name];
      if (name.indexOf("--cb-") === 0 && typeof value === "string" && value.length <= 200) {
        root.style.setProperty(name, value);
      }
    });
  }

  function api(path, method, body) {
    var headers = { authorization: "Bearer " + token };
    var init = { method: method || "GET", headers: headers, credentials: "omit" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function resize() {
    post({ type: "resize", height: Math.ceil(document.documentElement.scrollHeight) });
  }

  function render(cards) {
    var columns = $("columns");
    columns.textContent = "";
    STATUSES.forEach(function (status) {
      var section = document.createElement("section");
      section.setAttribute("aria-label", t(status));
      section.setAttribute("data-status", status);
      var h = document.createElement("h2");
      h.textContent = t(status);
      section.appendChild(h);
      var mine = cards.filter(function (c) { return c.status === status; });
      if (mine.length === 0) {
        var empty = document.createElement("p");
        empty.textContent = t("empty");
        section.appendChild(empty);
      }
      mine.forEach(function (card) {
        var el = document.createElement("article");
        el.setAttribute("aria-label", card.title);
        var p = document.createElement("p");
        p.textContent = card.title;
        el.appendChild(p);
        var moves = document.createElement("div");
        moves.className = "moves";
        STATUSES.filter(function (s) { return s !== status; }).forEach(function (to) {
          var b = document.createElement("button");
          b.type = "button";
          b.textContent = t("move") + " " + t(to);
          b.setAttribute("aria-label", card.title + ": " + t("move") + " " + t(to));
          b.addEventListener("click", function () {
            api("cards/" + encodeURIComponent(card.id), "POST", { status: to }).then(load, function () {
              setStatus(t("failed"), "warn");
            });
          });
          moves.appendChild(b);
        });
        el.appendChild(moves);
        section.appendChild(el);
      });
      columns.appendChild(section);
    });
    resize();
  }

  function load() {
    return api("cards").then(function (data) {
      $("app").setAttribute("aria-busy", "false");
      render(data.cards || []);
    }, function () {
      setStatus(t("failed"), "warn");
    });
  }

  /** SSE over fetch（EventSource 不能带 Authorization 头）。流在令牌过期时由插件结束，用新令牌重连。 */
  function listen() {
    fetch("events", { headers: { authorization: "Bearer " + token }, credentials: "omit" }).then(function (res) {
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += decoder.decode(r.value, { stream: true });
          var i;
          while ((i = buf.indexOf("\\n\\n")) >= 0) {
            var block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            var event = "";
            block.split("\\n").forEach(function (line) {
              if (line.indexOf("event:") === 0) event = line.slice(6).trim();
            });
            if (event === "ready") { setStatus(t("live")); load(); }
            if (event === "cards") load();
          }
          return pump();
        });
      }
      return pump();
    }).then(function () {
      setTimeout(listen, 500);
    }, function () {
      setStatus(t("lost"), "warn");
      setTimeout(listen, 3000);
    });
  }

  function start() {
    $("title").setAttribute("placeholder", t("title"));
    $("title").setAttribute("aria-label", t("title"));
    $("add").textContent = t("add");
    $("new").hidden = false;
    $("new").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = $("title");
      var title = input.value.trim();
      if (!title) return;
      api("cards", "POST", { title: title }).then(function () {
        input.value = "";
        post({ type: "toast", text: t("added") });
        load();
      }, function () { setStatus(t("failed"), "warn"); });
    });
    setStatus(t("loading"));
    if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(document.body);
    load();
    listen();
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || typeof m !== "object" || m.protocol !== PROTOCOL) return;
    if (m.type === "init" && typeof m.token === "string") {
      token = m.token;
      locale = m.locale === "zh" ? "zh" : "en";
      document.documentElement.lang = locale;
      applyTokens(m.tokens, m.theme);
      if (!started) { started = true; start(); }
    } else if (m.type === "token" && typeof m.token === "string") {
      token = m.token;
    } else if (m.type === "theme") {
      applyTokens(m.tokens, m.theme);
    }
  });
})();
`;
