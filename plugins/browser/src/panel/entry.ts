// Browser entry of the panel page: bundled to `panel.js` (esbuild, iife) and served next to the page.
import { mountPanel } from "./panel.js";

mountPanel({ window });
