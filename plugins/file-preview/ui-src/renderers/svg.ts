/**
 * The svg previewer: the file as `<img src="blob:…">` only. An image never runs the SVG's script
 * and loads none of its external references; the markup never enters the DOM.
 */
import { showEmpty } from "../app/frame.js";
import { THEME } from "../app/theme.js";
import type { Renderer } from "../app/types.js";

const STRINGS = {
  zh: { invalid: "不是有效的 SVG 图像" },
  en: { invalid: "Not a valid SVG image" },
} as const;

/** Checkerboard ground in the embed's theme, so transparent parts read as transparent. */
const GROUND =
  `background-color:${THEME.panel};background-image:` +
  `linear-gradient(45deg,${THEME.hover} 25%,transparent 25%,transparent 75%,${THEME.hover} 75%),` +
  `linear-gradient(45deg,${THEME.hover} 25%,transparent 25%,transparent 75%,${THEME.hover} 75%);` +
  "background-size:16px 16px;background-position:0 0,8px 8px";

const render: Renderer = async (file, ctx) => {
  if (file.data.byteLength === 0) {
    showEmpty(ctx.root, ctx.t);
    return;
  }
  const doc = ctx.root.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error("svg previewer needs a window");
  const url = win.URL.createObjectURL(new Blob([file.data], { type: "image/svg+xml" }));

  const box = doc.createElement("div");
  box.className = "cap-svg";
  box.style.cssText = `display:flex;align-items:center;justify-content:center;height:100%;box-sizing:border-box;padding:16px;${GROUND}`;
  const img = doc.createElement("img");
  img.alt = file.name;
  // zoom to fit: never larger than the panel, aspect ratio kept
  img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain";

  const loaded = new Promise<boolean>((resolve) => {
    img.addEventListener("load", () => resolve(true), { once: true });
    img.addEventListener("error", () => resolve(false), { once: true });
    ctx.signal.addEventListener("abort", () => resolve(true), { once: true });
  });
  img.src = url;
  box.append(img);
  ctx.root.replaceChildren(box);

  const ok = await loaded;
  // the decoded image stays painted; the URL is not needed after load
  win.URL.revokeObjectURL(url);
  if (!ok && !ctx.signal.aborted) ctx.showError(STRINGS[ctx.locale].invalid);
};

export { render };
