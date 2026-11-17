/** The `code` worker's wire types (shared by the app and the worker TypeScript projects). */

export interface HighlightInput {
  text: string;
  lang: string;
  theme: "dark" | "light";
}

export interface HighlightOutput {
  lines: { content: string; color?: string }[][];
  truncated: boolean;
}
