// @vitest-environment jsdom

import type { JsonValue } from "@capybara-hq/plugin-client";
import type { FakeHost } from "@capybara-hq/plugin-client/testing";
import { act, createElement, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ItemForm } from "../../src/client/item-form.js";
import { ItemsTable } from "../../src/client/items-table.js";
import { ItemPanel, ItemProperties } from "../../src/client/panel.js";
import { ProjectsPage } from "../../src/client/router.js";
import type {
  ActivityEntry,
  ItemActivityParams,
  ProjectItemsParams,
  ProjectSettingsResult,
} from "../../src/page/contract.js";
import {
  BEN,
  boardResult,
  buttonByText,
  card,
  click,
  detailResult,
  flush,
  lastProps,
  MIA,
  PROJECT,
  PROJECTS_LIST,
  panelItem,
  render,
  STATUSES,
  TYPES,
  text,
} from "./fixtures.js";
import { fireInput } from "./input.js";

type Call = { actionId: string; payload: unknown };
type Queries = Record<string, (p: JsonValue) => unknown>;

let host: FakeHost | undefined;
afterEach(() => {
  host?.unmount();
  host = undefined;
});

const SETTINGS: ProjectSettingsResult = {
  project: PROJECT,
  members: [
    { person: MIA, role: "owner", functionLabel: "product", defaultAgent: null, canSetAgent: true },
    { person: BEN, role: "member", functionLabel: "qa", defaultAgent: null, canSetAgent: false },
  ],
  types: [{ ...TYPES[0], statuses: STATUSES } as ProjectSettingsResult["types"][number]],
  canEdit: true,
};

function renderPage(params: Record<string, string>, queries: Queries) {
  const calls: Call[] = [];
  host = render(createElement(ProjectsPage), {
    slot: "org.page",
    contribution: "projects",
    params,
    queries,
    onAction: async (actionId, input) => {
      calls.push({ actionId, payload: input?.payload });
      // success answers carry no toast (a toast is a refusal)
      return { invalidate: ["projects.list"] };
    },
  });
  return { host, calls };
}

describe("successful actions", () => {
  it("creating a project closes the dialog and opens the new project", async () => {
    const { host: h, calls } = renderPage({}, { "projects.list": () => PROJECTS_LIST });
    await flush();
    const header = lastProps.ListPage?.header as { actions: { onSelect(): void }[] };
    await act(async () => header.actions[0]?.onSelect());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await fireInput(document.querySelector('input[aria-label="Project key"]'), "web");
    await fireInput(document.querySelector('input[aria-label="Name"]'), "Website");
    await click(buttonByText("Create"));
    expect(calls).toEqual([
      { actionId: "project.create", payload: { key: "WEB", name: "Website" } },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.navigations).toEqual([{ params: { project: "WEB" } }]);
  });

  it("creating an item closes the dialog", async () => {
    const closed: boolean[] = [];
    host = render(
      createElement(ItemForm, {
        open: true,
        onOpenChange: (open: boolean) => closed.push(open),
        project: { id: PROJECT.id, key: PROJECT.key },
        types: TYPES,
      }),
      {
        slot: "org.page",
        queries: { "people.search": () => ({ people: [MIA] }) },
        onAction: async () => ({ invalidate: ["project.board"] }),
      },
    );
    await flush();
    await fireInput(document.querySelector('input[aria-label="Title"]'), "Fix it");
    await click(buttonByText("Create"));
    expect(closed).toEqual([false]);
  });
});

describe("board states", () => {
  it("a failed board query shows an error state whose retry refetches", async () => {
    let fail = true;
    const { host: h } = renderPage(
      { project: "APP" },
      {
        "project.board": () => {
          if (fail) throw new Error("ui.query_failed");
          return boardResult();
        },
      },
    );
    await flush();
    expect(lastProps.EmptyState?.text).toBe("Could not load");
    fail = false;
    const action = lastProps.EmptyState?.action as { onSelect(): void };
    await act(async () => action.onSelect());
    await flush();
    expect(h.queryCalls("project.board")).toBe(2);
    expect(document.querySelector('[data-fake-design="Board"]')).not.toBeNull();
  });

  it("a card with a pending gate request says it awaits confirmation and where to", async () => {
    renderPage(
      { project: "APP" },
      { "project.board": () => boardResult({ cards: [card({ pendingGate: "ready" })] }) },
    );
    await flush();
    expect(document.querySelector(`[data-card="${card().id}"]`)?.textContent).toContain(
      "Awaiting confirmation → Ready",
    );
  });

  it("the table goes back to page 1 when the filter changes", async () => {
    const pages: (number | undefined)[] = [];
    let setMine: (v: boolean) => void = () => {};
    function Harness() {
      const [mine, set] = useState(false);
      setMine = set;
      return createElement(ItemsTable, {
        project: "APP",
        type: undefined,
        filter: mine ? { responsible: "me" } : {},
      });
    }
    host = render(createElement(Harness), {
      slot: "org.page",
      queries: {
        "project.items": (p) => {
          pages.push((p as unknown as ProjectItemsParams).page);
          return {
            project: PROJECT,
            types: TYPES,
            rows: [],
            total: 120,
            page: 1,
            pageSize: 50,
            canEdit: true,
          };
        },
      },
    });
    await flush();
    const pagination = lastProps.DataTable?.pagination as { onPage(p: number): void };
    await act(async () => pagination.onPage(2));
    await flush();
    await act(async () => setMine(true));
    await flush();
    expect(pages).toEqual([1, 2, 1]);
  });
});

describe("activity", () => {
  const entry = (id: string): ActivityEntry => ({
    id,
    kind: "commented",
    actor: { person: MIA, agent: null },
    at: "2026-11-28T08:00:00.000Z",
    detail: {},
    comment: `comment ${id}`,
    people: {},
    agents: {},
  });

  it("an invalidation reads the history again from the top", async () => {
    let newest = ["e3", "e2"];
    const { host: h } = renderPage(
      { item: "APP-1" },
      {
        "item.detail": () => detailResult(),
        "item.activity": (p) =>
          (p as unknown as ItemActivityParams).before === undefined
            ? { entries: newest.map(entry), next: "c1" }
            : { entries: [entry("e1")], next: null },
      },
    );
    await flush();
    const tabs = lastProps.DetailPage?.tabs as { onChange(id: string): void };
    await act(async () => tabs.onChange("activity"));
    await flush();
    const list = () => lastProps.ItemList as { onLoadMore(): void };
    await act(async () => list().onLoadMore());
    await flush();
    expect(text()).toContain("comment e1");
    newest = ["e5", "e4"];
    h.invalidate(["item.activity"]);
    await flush();
    expect(text()).toContain("comment e5");
    // the older page is dropped (its cursor no longer meets the new first page)
    expect(text()).not.toContain("comment e1");
  });
});

describe("panel refresh", () => {
  it("reads the item again when a tool call or run of this conversation finishes", async () => {
    host = render(createElement(ItemPanel), {
      slot: "conversation.panel",
      args: { conversationId: "conv-1" },
      queries: { "item.byConversation": () => ({ item: panelItem() }) },
    });
    await flush();
    const base = { seq: 1, at: "2026-11-28T08:00:00.000Z" };
    host.emit({
      type: "tool.finished",
      conversationId: "conv-1",
      callId: "c",
      tool: "t",
      isError: false,
      ...base,
    });
    await flush();
    expect(host.queryCalls("item.byConversation")).toBe(2);
    host.emit({ type: "run.finished", conversationId: "conv-2", reason: "done", ...base });
    await flush();
    expect(host.queryCalls("item.byConversation")).toBe(2);
    host.emit({ type: "run.finished", conversationId: "conv-1", reason: "done", ...base });
    await flush();
    expect(host.queryCalls("item.byConversation")).toBe(3);
  });

  it("the properties section draws only its body (the host draws the section)", async () => {
    host = render(createElement(ItemProperties), {
      slot: "conversation.properties.section",
      args: { conversationId: "conv-1" },
      queries: { "item.byConversation": () => ({ item: panelItem() }) },
    });
    await flush();
    expect(document.querySelector('[data-fake-design="PropertySection"]')).toBeNull();
    expect(text()).toContain("APP-1 Write the login page");
  });
});

describe("settings", () => {
  it("removing a member asks through a danger confirmation first", async () => {
    const { calls } = renderPage(
      { project: "APP", settings: "1" },
      { "project.settings": () => SETTINGS },
    );
    await flush();
    const menu = lastProps.DataTable?.rowMenu as (
      m: unknown,
    ) => { label: string; onSelect(): void }[];
    expect(menu(SETTINGS.members[0]).map((i) => i.label)).toEqual(["Edit"]);
    const remove = menu(SETTINGS.members[1]).find((i) => i.label === "Remove");
    await act(async () => remove?.onSelect());
    expect(calls).toEqual([]);
    const confirm = lastProps.DangerConfirm as { description: string; onConfirm(): Promise<void> };
    expect(confirm.description).toContain("project owner");
    await act(async () => confirm.onConfirm());
    await flush();
    expect(calls).toEqual([
      { actionId: "member.remove", payload: { projectId: PROJECT.id, accountId: BEN.id } },
    ]);
  });

  it("a non-owner's rows open nothing; only their own row offers Edit", async () => {
    const settings: ProjectSettingsResult = {
      ...SETTINGS,
      canEdit: false,
      members: [
        {
          ...(SETTINGS.members[0] as ProjectSettingsResult["members"][number]),
          canSetAgent: false,
        },
        { ...(SETTINGS.members[1] as ProjectSettingsResult["members"][number]), canSetAgent: true },
      ],
    };
    renderPage({ project: "APP", settings: "1" }, { "project.settings": () => settings });
    await flush();
    expect(lastProps.DataTable?.onOpen).toBeUndefined();
    const menu = lastProps.DataTable?.rowMenu as (m: unknown) => { label: string }[];
    expect(menu(settings.members[0])).toEqual([]);
    expect(menu(settings.members[1]).map((i) => i.label)).toEqual(["Edit"]);
    const nav = lastProps.SettingsPage?.nav as { items: { id: string }[] }[];
    expect(nav[0]?.items.map((i) => i.id)).not.toContain("general");
  });

  it("General saves the name, description and archive flag", async () => {
    const { calls } = renderPage(
      { project: "APP", settings: "1", section: "general" },
      { "project.settings": () => SETTINGS },
    );
    await flush();
    await fireInput(document.querySelector('input[aria-label="Name"]'), "App v2");
    await click(document.querySelector('[role="switch"]') as Element);
    await click(buttonByText("Save"));
    expect(calls).toEqual([
      {
        actionId: "settings.save",
        payload: { projectId: PROJECT.id, name: "App v2", description: "The app", archived: true },
      },
    ]);
  });

  it("a person the kernel no longer knows is never named by their id", async () => {
    const gone = { id: "acc-gone", name: "acc-gone", avatar: null };
    renderPage(
      { project: "APP", settings: "1" },
      {
        "project.settings": () => ({
          ...SETTINGS,
          members: [
            ...SETTINGS.members,
            {
              person: gone,
              role: "member",
              functionLabel: null,
              defaultAgent: null,
              canSetAgent: false,
            },
          ],
        }),
      },
    );
    await flush();
    const table =
      document.querySelector('table[aria-label="Members & functions"]')?.textContent ?? "";
    expect(table).toContain("Unknown member");
    expect(table).not.toContain("acc-gone");
  });
});

describe("size budget", () => {
  it("a truncated list says only part is shown", async () => {
    renderPage({}, { "projects.list": () => ({ ...PROJECTS_LIST, truncated: true }) });
    await flush();
    expect(text()).toContain("only part is shown");
  });

  it("a clipped comment loads in full with Show all", async () => {
    renderPage(
      { item: "APP-1" },
      {
        "item.detail": () => detailResult(),
        "item.activity": () => ({
          entries: [
            {
              id: "a1",
              kind: "commented",
              actor: { person: MIA, agent: null },
              at: "2026-11-28T08:00:00.000Z",
              detail: { commentId: "cm1" },
              comment: "the start of a long",
              clipped: true,
              people: {},
              agents: {},
            },
          ],
          next: null,
        }),
        "item.comment": (p) => ({
          id: (p as { commentId: string }).commentId,
          body: "the start of a long comment, in full",
          author: { person: MIA, agent: null },
          at: "2026-11-28T08:00:00.000Z",
        }),
      },
    );
    await flush();
    const tabs = lastProps.DetailPage?.tabs as { onChange(id: string): void };
    await act(async () => tabs.onChange("activity"));
    await flush();
    expect(text()).not.toContain("in full");
    await click(buttonByText("Show all"));
    expect(text()).toContain("the start of a long comment, in full");
  });
});
