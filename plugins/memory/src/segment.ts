/**
 * Word segmentation for keyword search. `Intl.Segmenter` finds word boundaries (locale `zh` for
 * runs of CJK characters, `en` otherwise), so Chinese with no spaces still yields words. Each CJK
 * run also yields its character bigrams: the segmenter's split depends on context ("插件" can come
 * out as "插" + "件"), and bigrams keep a two-character word findable inside any longer text.
 * The tokens are stored and queried as a `simple` tsvector; both sides go through this function.
 */

// capybara:allow-module-state read-only character class
const CJK_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
// capybara:allow-module-state read-only character class
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * The search tokens of `text`, in order: the word-like segments (lowercased), and for every CJK run
 * of three or more characters its bigrams. Punctuation, spaces and symbols yield nothing.
 */
export function segment(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(CJK_RUN) ?? []) {
    const cjk = CJK.test(run);
    const segmenter = new Intl.Segmenter(cjk ? "zh" : "en", { granularity: "word" });
    for (const s of segmenter.segment(run)) {
      if (s.isWordLike) out.push(s.segment.toLowerCase());
    }
    if (cjk) {
      const chars = [...run];
      if (chars.length > 2) {
        for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
      }
    }
  }
  return out;
}

/** The tokens of a memory: its path (directory and word separators as spaces), description and body. */
export function segmentMemory(m: { path: string; description: string; body: string }): string[] {
  const path = m.path.replace(/\.md$/, "").replace(/[/\-_.]/g, " ");
  return [...segment(path), ...segment(m.description), ...segment(m.body)];
}
