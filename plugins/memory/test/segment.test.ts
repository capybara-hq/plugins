import { describe, expect, it } from "vitest";
import { segment, segmentMemory } from "../src/segment.js";

describe("segment", () => {
  it("splits Chinese without spaces into words a part of it can match", () => {
    const tokens = segment("回复一律用中文");
    expect(tokens).toContain("中文");
    expect(tokens).toContain("回复");
  });

  it("emits bigrams of a CJK run so a two-character word inside a longer word matches", () => {
    // ICU splits 插件 into single characters inside this phrase; the bigram keeps 插件 findable
    expect(segment("记忆插件的设计")).toContain("插件");
  });

  it("splits English on word boundaries, lowercased, words only", () => {
    expect(segment("Reply in Chinese")).toEqual(["reply", "in", "chinese"]);
    expect(segment("  Hello, World!  ")).toEqual(["hello", "world"]);
  });

  it("handles mixed text", () => {
    const tokens = segment("Use TypeScript 写代码");
    expect(tokens).toEqual(expect.arrayContaining(["use", "typescript", "写", "代码"]));
  });

  it("returns nothing for punctuation and SQL wildcards", () => {
    expect(segment("% _ ... !!")).toEqual([]);
  });

  it("segments a memory's path, description and body", () => {
    const tokens = segmentMemory({
      path: "feedback/reply-in-chinese.md",
      description: "Language",
      body: "回复一律用中文",
    });
    expect(tokens).toEqual(
      expect.arrayContaining(["feedback", "reply", "in", "chinese", "language", "中文"]),
    );
  });
});
