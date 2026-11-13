// @vitest-environment jsdom

import { type FakeHost, renderWithFakeHost } from "@capybara-hq/plugin-client/testing";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE_CONFIRM } from "../src/client/i18n.js";
import { MemoryPage } from "../src/client/page.js";
import extension from "../src/client.js";
import type { GraphNode, MemoryDetail, MemoryPageData } from "../src/page.js";

const SLOT = "org.page";
const ME = "acc-mia";
const BEN = "acc-ben";
const AGENT = "agent-1";

function node(id: string, path: string, recalls = 1): GraphNode {
  return {
    id,
    path,
    type: path.split("/")[0] as GraphNode["type"],
    description: `About ${path}`,
    recalls,
    lastRecalledAt: "2026-11-12T08:00:00.000Z",
    dir: path.slice(0, path.lastIndexOf("/")),
  };
}

const NODES = [
  node("m1", "user/coffee.md", 9),
  node("m2", "feedback/reply-in-chinese.md", 3),
  node("m3", "project/github/probe.md", 0),
];

function pageData(over: Partial<MemoryPageData> = {}): MemoryPageData {
  return {
    canAdmin: false,
    editable: true,
    agents: [{ id: AGENT, name: "Helper" }],
    selection: { agentId: AGENT, accountId: ME },
    nodes: NODES,
    edges: [{ from: "m1", to: "m2", kind: "link" }],
    total: NODES.length,
    truncated: false,
    cursor: null,
    ...over,
  };
}

const detailOf = (n: GraphNode): MemoryDetail => ({
  ...n,
  body: `Body of ${n.path}`,
  links: [{ path: "tea", targetId: null }],
  createdAt: "2026-11-01T08:00:00.000Z",
  createdIn: "conv-1",
  updatedAt: "2026-11-02T08:00:00.000Z",
});

type Call = { actionId: string; payload: Record<string, unknown> };

/** Richer design stand-ins than the fake host's: buttons that click, key-value rows that show. */
function installDesign(): void {
  const host = (globalThis as Record<string, unknown>).__CAPYBARA_CLIENT_HOST__ as {
    design: Record<string, unknown>;
  };
  host.design = {
    ...host.design,
    Button: (p: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      type?: "button" | "submit";
      "aria-label"?: string;
    }) =>
      createElement(
        "button",
        {
          type: p.type ?? "button",
          onClick: p.onClick,
          disabled: p.disabled,
          "aria-label": p["aria-label"],
          "data-fake-design": "Button",
        },
        p.children,
      ),
    KeyValue: ({ rows }: { rows: { k: ReactNode; v: ReactNode }[] }) =>
      createElement(
        "dl",
        null,
        rows.map((r, i) =>
          createElement(
            "div",
            { key: i },
            createElement("dt", null, r.k),
            createElement("dd", null, r.v),
          ),
        ),
      ),
  };
}

let host: FakeHost | undefined;
let calls: Call[];
let frames: number;

function render(opts: {
  data?: MemoryPageData;
  role?: "member" | "admin" | "guest";
  locale?: "zh" | "en";
  reducedMotion?: boolean;
  answer?: (c: Call) => { view?: { blocks: []; data: unknown }; toast?: string };
}) {
  const h = renderWithFakeHost(
    createElement(MemoryPage, { plugin: "memory", contribution: "memory-page", slot: SLOT }),
    {
      slot: SLOT,
      plugin: "memory",
      contribution: "memory-page",
      role: opts.role ?? "member",
      locale: opts.locale ?? "en",
      reducedMotion: opts.reducedMotion ?? true,
      view: { blocks: [], data: (opts.data ?? pageData()) as never },
      onAction: async (actionId, input) => {
        const c = { actionId, payload: (input?.payload ?? {}) as Record<string, unknown> };
        calls.push(c);
        return (opts.answer?.(c) ?? {}) as never;
      },
    },
  );
  installDesign();
  h.rerender();
  host = h;
  return h;
}

/** Lets pending action promises and their state updates run. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

const text = () => document.body.textContent ?? "";
const buttons = (label: string) =>
  [...document.querySelectorAll("button")].filter(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  );
const click = async (el: Element | undefined) => {
  if (el === undefined) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
};
const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".cx-memory-row")];
const toList = () => click(buttons("List")[0]);

const openAnswer = (c: Call) => {
  if (c.actionId === "open") {
    const n = NODES.find((x) => x.id === c.payload.memoryId) as GraphNode;
    return { view: { blocks: [] as [], data: { detail: detailOf(n) } } };
  }
  if (c.actionId === "delete") {
    return {
      view: { blocks: [] as [], data: pageData({ nodes: NODES.slice(1), total: 2 }) },
    };
  }
  return {};
};

beforeEach(() => {
  calls = [];
  frames = 0;
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      new Proxy(
        {},
        { get: () => () => {}, set: () => true },
      ) as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal("requestAnimationFrame", () => {
    frames += 1;
    return frames;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  host?.unmount();
  host = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("memory page", () => {
  it("is the org.page component of the client entry", () => {
    expect(extension.name).toBe("memory");
    expect(extension.components?.["memory-page"]?.slot).toBe("org.page");
  });

  it("renders the memories: the count, the canvas and one list row per node", async () => {
    render({});
    expect(text()).toContain("3 memories");
    expect(document.querySelector("canvas.cx-memory-canvas")?.getAttribute("aria-label")).toContain(
      "3 memories",
    );
    await toList();
    expect(rows().map((r) => r.dataset.memoryId)).toEqual(["m2", "m3", "m1"]);
  });

  it("fetches the rest with `more` until the cursor is null and merges by id", async () => {
    const extra = node("m4", "reference/docs.md");
    render({
      data: pageData({ nodes: NODES.slice(0, 2), total: 4, truncated: true, cursor: "feedback/x" }),
      answer: (c) => {
        if (c.actionId !== "more") return {};
        const data =
          c.payload.cursor === "feedback/x"
            ? { nodes: [NODES[1], NODES[2]], edges: [], truncated: true, cursor: "project/z" }
            : { nodes: [extra], edges: [], truncated: false, cursor: null };
        return { view: { blocks: [], data } };
      },
    });
    await flush();
    expect(calls.map((c) => [c.actionId, c.payload.cursor])).toEqual([
      ["more", "feedback/x"],
      ["more", "project/z"],
    ]);
    expect(calls[0]?.payload).toMatchObject({ agentId: AGENT, accountId: ME });
    expect(text()).toContain("4 memories");
    await toList();
    expect(rows()).toHaveLength(4);
  });

  it("opens a memory from the list and from the keyboard on the canvas; the page stays", async () => {
    render({ answer: openAnswer });
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    await act(async () => {
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.querySelector(".cx-memory-live")?.textContent).toContain(
      "feedback/reply-in-chinese.md",
    );
    await act(async () => {
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(calls.at(-1)).toEqual({
      actionId: "open",
      payload: { agentId: AGENT, accountId: ME, memoryId: "m2" },
    });
    expect(text()).toContain("Body of feedback/reply-in-chinese.md");

    await toList();
    await click(rows().find((r) => r.dataset.memoryId === "m3"));
    expect(calls.at(-1)?.payload.memoryId).toBe("m3");
    expect(text()).toContain("Body of project/github/probe.md");
    // the open answer did not replace the page's nodes
    expect(rows()).toHaveLength(3);
  });

  it("asks before deleting, with the spec's confirmation copy, then shows the new page", async () => {
    render({ answer: openAnswer });
    await toList();
    await click(rows()[2]);
    expect(buttons("Edit")).toHaveLength(1);
    await click(buttons("Delete")[0]);
    expect(text()).toContain(DELETE_CONFIRM.en);
    expect(calls.some((c) => c.actionId === "delete")).toBe(false);
    await click(buttons("Delete").at(-1));
    expect(calls.at(-1)).toEqual({
      actionId: "delete",
      payload: { agentId: AGENT, accountId: ME, memoryId: "m1" },
    });
    expect(rows()).toHaveLength(2);
    expect(document.querySelector(".cx-memory-panel")).toBeNull();
  });

  it("says it in Chinese, with 智能体 and the verbatim zh confirmation", async () => {
    render({ locale: "zh", answer: openAnswer });
    expect(text()).toContain("智能体");
    expect(text()).not.toMatch(/agent/i);
    await click(buttons("列表")[0]);
    await click(rows()[0]);
    await click(buttons("删除")[0]);
    expect(text()).toContain(
      "已删除的记忆不会再出现在新的索引里，但之前对话中已出现的内容仍保留在那些对话的记录中。",
    );
  });

  it("an admin viewing another member gets the member select, delete, and no edit", async () => {
    render({
      role: "admin",
      data: pageData({
        canAdmin: true,
        editable: false,
        members: [
          { id: ME, name: "Mia" },
          { id: BEN, name: "Ben" },
        ],
        selection: { agentId: AGENT, accountId: BEN },
      }),
      answer: openAnswer,
    });
    const select = document.querySelector<HTMLSelectElement>(
      '[data-testid="memory-member-select"]',
    );
    expect(select?.value).toBe(BEN);
    expect(text()).toContain("You are viewing Ben's memories");
    await toList();
    await click(rows()[0]);
    expect(calls.at(-1)?.payload).toMatchObject({ accountId: BEN, agentId: AGENT });
    expect(buttons("Edit")).toHaveLength(0);
    expect(buttons("Delete")).toHaveLength(1);
  });

  it("a member gets no member select", () => {
    render({});
    expect(document.querySelector('[data-testid="memory-member-select"]')).toBeNull();
  });

  it("an admin switching members calls `select` with the account and adopts the answer", async () => {
    const benPage = pageData({
      canAdmin: true,
      editable: false,
      members: [
        { id: ME, name: "Mia" },
        { id: BEN, name: "Ben" },
      ],
      selection: { agentId: AGENT, accountId: BEN },
      nodes: [node("b1", "user/ben.md")],
      total: 1,
    });
    render({
      role: "admin",
      data: pageData({
        canAdmin: true,
        members: [
          { id: ME, name: "Mia" },
          { id: BEN, name: "Ben" },
        ],
      }),
      answer: (c) => (c.actionId === "select" ? { view: { blocks: [], data: benPage } } : {}),
    });
    const select = document.querySelector(
      '[data-testid="memory-member-select"]',
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = BEN;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(calls.at(-1)).toEqual({ actionId: "select", payload: { accountId: BEN } });
    expect(text()).toContain("1 memory");
  });

  it("search results highlight hits without replacing the page", async () => {
    render({
      answer: (c) =>
        c.actionId === "search"
          ? {
              view: {
                blocks: [],
                data: {
                  hits: [
                    { id: "m1", path: "user/coffee.md", description: "d", snippet: "espresso" },
                  ],
                },
              },
            }
          : {},
    });
    const input = document.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, "coffee");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.form?.requestSubmit();
    });
    await flush();
    expect(calls.at(-1)).toEqual({
      actionId: "search",
      payload: { agentId: AGENT, accountId: ME, query: "coffee" },
    });
    expect(text()).toContain("espresso");
    await toList();
    expect(rows().map((r) => r.dataset.memoryId)).toEqual(["m1"]);
    expect(text()).toContain("3 memories");
  });

  it("animates with motion, and stops under reduced motion (the layout settles once)", () => {
    render({ reducedMotion: true });
    expect(frames).toBe(0);
    host?.unmount();
    render({ reducedMotion: false });
    expect(frames).toBeGreaterThan(0);
  });

  it("shows the empty state when the member has no memories yet", () => {
    render({
      data: pageData({
        agents: [],
        selection: { agentId: null, accountId: ME },
        nodes: [],
        edges: [],
        total: 0,
      }),
    });
    expect(text()).toContain("No memories yet");
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("shows the no-access state to a guest", () => {
    render({ role: "guest" });
    expect(text()).toContain("Only org members can see memories.");
  });
});
