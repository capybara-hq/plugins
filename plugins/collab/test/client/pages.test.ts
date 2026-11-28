// @vitest-environment jsdom

import type { FakeHost } from "@capybara-hq/plugin-client/testing";
import { act, createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectsPage } from "../../src/client/router.js";
import extension from "../../src/client.js";
import type { ProjectItemsResult, ProjectSettingsResult } from "../../src/page/contract.js";
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
  render,
  STATUSES,
  TYPES,
  templateCount,
  text,
} from "./fixtures.js";
import { fireInput } from "./input.js";

const SLOT = "org.page";

const ITEMS: ProjectItemsResult = {
  project: PROJECT,
  types: TYPES,
  rows: [],
  total: 0,
  page: 1,
  pageSize: 50,
  canEdit: true,
};

const SETTINGS: ProjectSettingsResult = {
  project: PROJECT,
  members: [
    { person: MIA, role: "owner", functionLabel: "product", defaultAgent: null, canSetAgent: true },
    { person: BEN, role: "member", functionLabel: "qa", defaultAgent: null, canSetAgent: false },
  ],
  types: [{ ...TYPES[0], statuses: STATUSES } as ProjectSettingsResult["types"][number]],
  canEdit: true,
};

const QUERIES = {
  "projects.list": () => PROJECTS_LIST,
  "project.board": () => boardResult(),
  "project.items": () => ITEMS,
  "item.detail": () => detailResult(),
  "item.activity": () => ({ entries: [], next: null }),
  "item.conversations": () => ({ conversations: [] }),
  "project.settings": () => SETTINGS,
};

type Call = { actionId: string; payload: unknown };

let host: FakeHost | undefined;
afterEach(() => {
  host?.unmount();
  host = undefined;
});

function renderPage(
  params: Record<string, string>,
  opts: {
    onAction?: (c: Call) => { toast?: string; invalidate?: string[] };
    queries?: typeof QUERIES;
  } = {},
) {
  const calls: Call[] = [];
  host = render(createElement(ProjectsPage), {
    slot: SLOT,
    contribution: "projects",
    params,
    queries: opts.queries ?? QUERIES,
    onAction: async (actionId, input) => {
      const c = { actionId, payload: input?.payload };
      calls.push(c);
      return opts.onAction?.(c) ?? {};
    },
  });
  return { host, calls };
}

describe("collab client entry", () => {
  it("binds every manifest component to its slot", () => {
    expect(extension.name).toBe("collab");
    expect(
      Object.fromEntries(Object.entries(extension.components ?? {}).map(([k, c]) => [k, c.slot])),
    ).toEqual({
      projects: "org.page",
      "item-panel": "conversation.panel",
      "item-properties": "conversation.properties.section",
      "agent-items": "agent.detail.section",
    });
  });
});

describe("project pages router", () => {
  it("no params renders the projects list", async () => {
    renderPage({});
    await flush();
    expect(document.querySelector('[data-fake-design="ListPage"]')).not.toBeNull();
    expect(document.querySelector('table[aria-label="Projects"]')).not.toBeNull();
    expect(text()).toContain("App");
    expect(host?.queryCalls("projects.list")).toBe(1);
  });

  it("opening a project row navigates to its board", async () => {
    const { host: h } = renderPage({});
    await flush();
    await click(document.querySelector(`tr[data-row-key="${PROJECT.id}"]`) as Element);
    expect(h.navigations).toEqual([{ params: { project: "APP" } }]);
  });

  it("exactly one template per route", async () => {
    const routes: Record<string, string>[] = [
      {},
      { project: "APP" },
      { project: "APP", view: "list" },
      { project: "APP", settings: "1" },
      { item: "APP-1" },
    ];
    for (const params of routes) {
      renderPage(params);
      // while loading and once loaded
      expect(templateCount(), JSON.stringify(params)).toBe(1);
      await flush();
      expect(templateCount(), JSON.stringify(params)).toBe(1);
      host?.unmount();
      host = undefined;
    }
  });

  it("a hidden project still renders one template, with the not-found state", async () => {
    renderPage(
      { project: "NOPE" },
      { queries: { ...QUERIES, "project.board": () => ({ notFound: true }) } as never },
    );
    await flush();
    expect(templateCount()).toBe(1);
    expect(lastProps.ListPage?.empty).toMatchObject({ text: "Not found, or you cannot see it." });
  });
});

describe("board", () => {
  it("project param renders the board with gate columns locked", async () => {
    renderPage({ project: "APP" });
    await flush();
    const columns = lastProps.Board?.columns as { id: string; locked?: boolean; hint?: string }[];
    expect(columns.map((c) => [c.id, c.locked])).toEqual([
      ["open", false],
      ["ready", true],
      ["doing", false],
    ]);
    expect(columns[1]?.hint).toContain("confirmation");
    expect(document.querySelector(`[data-card="${card().id}"]`)?.textContent).toContain("APP-1");
  });

  it("drag to next column calls item.move and invalidates on success", async () => {
    const { host: h, calls } = renderPage(
      { project: "APP" },
      { onAction: () => ({ invalidate: ["project.board", "project.items"] }) },
    );
    await flush();
    const before = h.queryCalls("project.board");
    const onMove = lastProps.Board?.onMove as (id: string, to: string, i: number) => Promise<void>;
    await act(async () => {
      await expect(onMove(card().id, "doing", 0)).resolves.toBeUndefined();
    });
    expect(calls).toEqual([
      { actionId: "item.move", payload: { itemId: card().id, version: 4, to: "doing" } },
    ]);
    // the host refetches what the action names (the fake host applies it on request)
    h.invalidate(["project.board"]);
    await flush();
    expect(h.queryCalls("project.board")).toBe(before + 1);
  });

  it("a move answered with a toast (gate request, conflict) snaps the card back", async () => {
    renderPage({ project: "APP" }, { onAction: () => ({ toast: "Asked Mia to confirm" }) });
    await flush();
    const onMove = lastProps.Board?.onMove as (id: string, to: string, i: number) => Promise<void>;
    await act(async () => {
      await expect(onMove(card().id, "ready", 0)).rejects.toThrow("Asked Mia to confirm");
    });
  });

  it("a viewer who may not edit cannot move cards", async () => {
    renderPage(
      { project: "APP" },
      { queries: { ...QUERIES, "project.board": () => boardResult({ canEdit: false }) } },
    );
    await flush();
    const move = document.querySelector<HTMLButtonElement>(
      `button[aria-label="Move ${card().id} to doing"]`,
    );
    expect(move?.disabled).toBe(true);
  });

  it("opening a card goes to the item page", async () => {
    const { host: h } = renderPage({ project: "APP" });
    await flush();
    await click(document.querySelector(`[data-card="${card().id}"] button`) as Element);
    expect(h.navigations).toEqual([{ params: { item: "APP-1", project: null, view: null } }]);
  });

  it("view=list renders the item table in the same frame", async () => {
    const { host: h } = renderPage({ project: "APP", view: "list" });
    await flush();
    expect(document.querySelector('table[aria-label="Items"]')).not.toBeNull();
    expect(h.queryCalls("project.board")).toBe(0);
  });
});

describe("item page", () => {
  it("item param renders detail tabs", async () => {
    renderPage({ item: "APP-1" });
    await flush();
    expect(document.querySelector('[data-fake-design="DetailPage"]')).not.toBeNull();
    const tabs = (lastProps.DetailPage as { tabs: { items: { label: string }[] } }).tabs.items.map(
      (x) => x.label,
    );
    expect(tabs).toEqual(["Overview", "Activity", "Artifacts", "Decisions", "Conversations"]);
    expect(text()).toContain("Login with **OAuth**");
  });

  it("the decisions tab answers with the chosen option", async () => {
    const { calls } = renderPage({ item: "APP-1" });
    await flush();
    const tabs = lastProps.DetailPage?.tabs as { onChange(id: string): void };
    await act(async () => tabs.onChange("decisions"));
    await flush();
    expect(text()).toContain("Use OAuth or passwords?");
    await click(
      [...document.querySelectorAll("button")].find((b) => b.textContent === "OAuth") as Element,
    );
    expect(calls).toEqual([
      {
        actionId: "decision.answer",
        payload: { decisionId: "33333333-3333-4333-8333-333333333333", optionId: "oauth" },
      },
    ]);
  });
});

describe("settings", () => {
  it("project with settings=1 renders the settings page with its sections (General for owners)", async () => {
    renderPage({ project: "APP", settings: "1" });
    await flush();
    const nav = lastProps.SettingsPage?.nav as { items: { id: string }[] }[];
    expect(nav[0]?.items.map((i) => i.id)).toEqual([
      "general",
      "members",
      "types",
      "gates",
      "defaults",
    ]);
    expect(
      document.querySelector('table[aria-label="Members & functions"]')?.textContent,
    ).toContain("Ben");
  });

  it("saving General sends only what changed (a stale form never sends archived)", async () => {
    const { calls } = renderPage({ project: "APP", settings: "1", section: "general" });
    await flush();
    await fireInput(document.querySelector('input[aria-label="Name"]'), "Renamed");
    await click(buttonByText("Save"));
    await flush();
    expect(calls).toEqual([
      { actionId: "settings.save", payload: { projectId: PROJECT.id, name: "Renamed" } },
    ]);
  });

  it("an archived project shows the banner and leaves only the archive switch usable", async () => {
    const archived: ProjectSettingsResult = {
      ...SETTINGS,
      project: { ...PROJECT, archived: true },
    };
    renderPage(
      { project: "APP", settings: "1", section: "general" },
      { queries: { ...QUERIES, "project.settings": () => archived } },
    );
    await flush();
    expect(text()).toContain("This project is archived and read-only.");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.disabled).toBe(
      true,
    );
    host?.unmount();
    renderPage(
      { project: "APP", settings: "1", section: "gates" },
      { queries: { ...QUERIES, "project.settings": () => archived } },
    );
    await flush();
    expect(
      document.querySelector<HTMLSelectElement>('select[aria-label="Task Doing Confirmer"]')
        ?.disabled,
    ).toBe(true);
  });

  it("changing a gate saves the status's gate", async () => {
    const { calls } = renderPage({ project: "APP", settings: "1", section: "gates" });
    await flush();
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Task Doing Confirmer"]',
    );
    expect(select).not.toBeNull();
    await act(async () => {
      (select as HTMLSelectElement).value = "function:qa";
      select?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(calls).toEqual([
      {
        actionId: "settings.save",
        payload: {
          projectId: PROJECT.id,
          statuses: [
            { type: "task", key: "doing", gate: { confirmer: "function", functionLabel: "qa" } },
          ],
        },
      },
    ]);
  });
});
