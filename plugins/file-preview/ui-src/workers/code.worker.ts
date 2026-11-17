import type { HighlightInput, HighlightOutput } from "../shared/code.js";
import { highlight } from "./code.logic.js";
import { serve } from "./serve.js";

serve<HighlightInput, HighlightOutput>(async (input) => ({ output: await highlight(input) }));
