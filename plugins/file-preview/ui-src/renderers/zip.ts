import type { Renderer } from "../app/types.js";

/** Stands in until this previewer's renderer is written. */
const render: Renderer = async (_file, ctx) => {
  ctx.showError("This previewer is not available yet");
};

export { render };
