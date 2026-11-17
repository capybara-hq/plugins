import type { Renderer } from "../app/types.js";

/** Stands in for a previewer whose renderer is not written yet. */
const render: Renderer = async (_file, ctx) => {
  ctx.showError("This previewer is not available yet");
};

export default render;
