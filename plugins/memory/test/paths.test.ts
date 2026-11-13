import { describe, expect, it } from "vitest";
import { MAX_LINKS, MAX_PATH_LENGTH, MEMORY_TYPES, parseLinks, parsePath } from "../src/paths.js";

const ok = (input: string) => {
  const r = parsePath(input);
  if (!r.ok) throw new Error(`expected ${input} to parse, got: ${r.error}`);
  return r;
};
const err = (input: string): string => {
  const r = parsePath(input);
  if (r.ok) throw new Error(`expected ${input} to be rejected, got ${r.path}`);
  return r.error;
};

describe("parsePath", () => {
  it("normalises case, a leading slash, whitespace and a missing .md", () => {
    expect(ok("feedback/Reply-In-Chinese")).toEqual({
      ok: true,
      path: "feedback/reply-in-chinese.md",
      type: "feedback",
      dirs: ["feedback"],
      name: "reply-in-chinese",
    });
    expect(ok("  /user/role.md ").path).toBe("user/role.md");
  });

  it("keeps deeper directories in dirs, the type first", () => {
    const r = ok("project/github/probe");
    expect(r.path).toBe("project/github/probe.md");
    expect(r.type).toBe("project");
    expect(r.dirs).toEqual(["project", "github"]);
    expect(r.name).toBe("probe");
  });

  it("accepts CJK segments", () => {
    const r = ok("project/记忆插件.md");
    expect(r.path).toBe("project/记忆插件.md");
    expect(r.name).toBe("记忆插件");
  });

  it("rejects a first segment that is not a memory type, naming the four types", () => {
    const e = err("notes/x.md");
    for (const t of MEMORY_TYPES) expect(e).toContain(`${t}/`);
  });

  it("rejects a bare type with no file name", () => {
    expect(err("user")).toMatch(/file name/i);
    expect(err("user/")).toMatch(/empty/i);
    expect(err("user/.md")).toMatch(/file name/i);
  });

  it("rejects .. and . segments and empty segments", () => {
    expect(err("user/../x")).toMatch(/\.\./);
    expect(err("user/./x")).toMatch(/\./);
    expect(err("../user/x")).toMatch(/\.\./);
    expect(err("user//x")).toMatch(/empty/i);
  });

  it("rejects characters outside lowercase a-z, 0-9, - _ . and CJK", () => {
    expect(err("user/a b")).toMatch(/character/i);
    expect(err("user/a%b")).toMatch(/character/i);
    expect(err("user/a\\b")).toMatch(/character/i);
    expect(err("user/café")).toMatch(/character/i);
  });

  it("rejects paths over the length limit", () => {
    const long = `user/${"a".repeat(MAX_PATH_LENGTH)}`;
    expect(err(long)).toContain(String(MAX_PATH_LENGTH));
    expect(
      ok(`user/${"a".repeat(MAX_PATH_LENGTH - "user/".length - ".md".length)}`).path,
    ).toHaveLength(MAX_PATH_LENGTH);
  });

  it("rejects an empty path", () => {
    expect(err("   ")).toMatch(/empty/i);
  });
});

describe("parseLinks", () => {
  it("returns [[…]] targets normalised and deduplicated, in order", () => {
    expect(parseLinks("see [[a]] and [[user/b.md]] [[a]]")).toEqual(["a", "user/b.md"]);
  });

  it("normalises bare names and paths like parsePath, dropping invalid targets", () => {
    expect(
      parseLinks("[[Reply-In-Chinese.md]] [[User/Role]] [[notes/x]] [[a b]] [[../x]]"),
    ).toEqual(["reply-in-chinese", "user/role.md"]);
  });

  it("keeps at most MAX_LINKS targets", () => {
    const body = Array.from({ length: MAX_LINKS + 10 }, (_, i) => `[[n${i}]]`).join(" ");
    const links = parseLinks(body);
    expect(links).toHaveLength(MAX_LINKS);
    expect(links[0]).toBe("n0");
  });

  it("returns nothing for a body without links", () => {
    expect(parseLinks("plain [text] and [[]]")).toEqual([]);
  });
});
