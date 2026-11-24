// The part of jsdom the panel tests use. Not @types/jsdom: installed in the workspace, vitest's
// optional types would pull it (and the DOM lib) into every Node test program.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    readonly window: Window & typeof globalThis;
  }
}
