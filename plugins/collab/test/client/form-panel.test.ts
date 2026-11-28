// @vitest-environment jsdom

import type { JsonValue } from "@capybara-hq/plugin-client";
import type { FakeHost } from "@capybara-hq/plugin-client/testing";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentItems } from "../../src/client/agent-items.js";
import { ItemForm } from "../../src/client/item-form.js";
import { ItemPanel, ItemProperties } from "../../src/client/panel.js";
import type { AgentsUsableParams, ItemDetail } from "../../src/page/contract.js";
import {
  BEN,
  BEN_AGENT,
  buttonByText,
  click,
  decision,
  detailResult,
  flush,
  MIA,
  MIA_AGENT,
  PROJECT,
  panelItem,
  render,
  TYPES,
  templateCount,
  text,
} from "./fixtures.js";
import { fireInput } from "./input.js";

let host: FakeHost | undefined;
afterEach(() => {
  host?.unmount();
  host = undefined;
});

type Call = { actionId: string; payload: unknown };

function renderFormFor(item?: ItemDetail) {
  const calls: Call[] = [];
  const usable: string[] = [];
  host = render(
    createElement(ItemForm, {
      open: true,
      onOpenChange: () => {},
      project: { id: PROJECT.id, key: PROJECT.key },
      types: TYPES,
      defaultType: "task",
      ...(item !== undefined && { item }),
    }),
    {
      slot: "org.page",
      queries: {
        "people.search": () => ({ people: [MIA, BEN] }),
        "agents.usable": (p: JsonValue) => {
          const { accountId } = p as unknown as AgentsUsableParams;
          usable.push(accountId);
          return { agents: accountId === BEN.id ? [BEN_AGENT] : [MIA_AGENT] };
        },
      },
      onAction: async (actionId, input) => {
        calls.push({ actionId, payload: input?.payload });
        return {};
      },
    },
  );
  return { calls, usable };
}

describe("item form", () => {
  const agentGroup = () => document.querySelector('[role="group"][aria-label="Agent"]');

  it("agent picker lists only agents usable by the chosen responsible", async () => {
    const { usable } = renderFormFor();
    await flush();
    // no person yet: the agent picker is empty and disabled, nothing asked
    expect(agentGroup()?.querySelectorAll("button")).toHaveLength(0);
    expect(usable).toEqual([]);

    await click(buttonByText("Ben"));
    expect(usable).toEqual([BEN.id]);
    expect([...(agentGroup()?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual(
      ["Ben's tester"],
    );

    await click(buttonByText("Mia"));
    expect(usable).toEqual([BEN.id, MIA.id]);
    expect([...(agentGroup()?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual(
      ["Mia's coder"],
    );
  });

  it("creates the item with the chosen person, agent, priority and labels", async () => {
    const { calls } = renderFormFor();
    await flush();
    const title = document.querySelector<HTMLInputElement>('input[aria-label="Title"]');
    const labels = document.querySelector<HTMLInputElement>('input[aria-label="Labels"]');
    await fireInput(title, "Fix the crash");
    await fireInput(labels, "web, urgent ,web");
    await click(buttonByText("Ben"));
    await click(buttonByText("Ben's tester"));
    await click(buttonByText("Create"));
    expect(calls).toEqual([
      {
        actionId: "item.create",
        payload: {
          projectId: PROJECT.id,
          type: "task",
          title: "Fix the crash",
          responsibleAccountId: BEN.id,
          agentId: BEN_AGENT.id,
          priority: 3,
          labels: ["web", "urgent"],
        },
      },
    ]);
  });

  it("refuses to create without a title", async () => {
    const { calls } = renderFormFor();
    await flush();
    await click(buttonByText("Create"));
    expect(calls).toEqual([]);
    expect(document.querySelector('input[aria-label="Title"]')?.getAttribute("aria-invalid")).toBe(
      "true",
    );
  });
});

describe("item form, editing", () => {
  it("changed fields and assignment go in one item.update at the item's version", async () => {
    const { calls } = renderFormFor(detailResult().item);
    await flush();
    await fireInput(
      document.querySelector<HTMLInputElement>('input[aria-label="Title"]'),
      "Login page v2",
    );
    await click(buttonByText("Ben"));
    await click(buttonByText("Ben's tester"));
    await click(buttonByText("Save"));
    expect(calls).toEqual([
      {
        actionId: "item.update",
        payload: {
          itemId: detailResult().item.id,
          version: 4,
          title: "Login page v2",
          description: "Login with **OAuth**",
          priority: 3,
          labels: ["web"],
          responsibleAccountId: BEN.id,
          agentId: BEN_AGENT.id,
        },
      },
    ]);
  });

  it("changed fields alone send item.update without an assignment", async () => {
    const { calls } = renderFormFor(detailResult().item);
    await flush();
    await fireInput(
      document.querySelector<HTMLInputElement>('input[aria-label="Title"]'),
      "Login page v2",
    );
    await click(buttonByText("Save"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.actionId).toBe("item.update");
    expect(calls[0]?.payload).not.toHaveProperty("responsibleAccountId");
  });

  it("only the assignment changed: item.assign", async () => {
    const { calls } = renderFormFor(detailResult().item);
    await flush();
    await click(buttonByText("Ben"));
    await click(buttonByText("Save"));
    expect(calls).toEqual([
      {
        actionId: "item.assign",
        payload: {
          itemId: detailResult().item.id,
          version: 4,
          responsibleAccountId: BEN.id,
          agentId: null,
        },
      },
    ]);
  });
});

describe("conversation panel", () => {
  it("panel shows the item for a collab conversation and nothing otherwise", async () => {
    host = render(createElement(ItemPanel), {
      slot: "conversation.panel",
      args: { conversationId: "conv-1" },
      queries: { "item.byConversation": () => ({ item: panelItem() }) },
    });
    await flush();
    expect(text()).toContain("Write the login page");
    expect(text()).toContain("APP-1");
    expect(text()).toContain("Use OAuth or passwords?");
    expect(templateCount()).toBe(0);
    host.unmount();

    host = render(createElement(ItemPanel), {
      slot: "conversation.panel",
      args: { conversationId: "conv-2" },
      queries: { "item.byConversation": () => ({ item: null }) },
    });
    await flush();
    expect(text()).toBe("");
  });

  it("the properties section answers a gate request", async () => {
    const calls: Call[] = [];
    const item = panelItem();
    item.openDecisions = [
      {
        ...item.openDecisions[0],
        kind: "gate",
        options: [],
        recommendation: null,
        gateTarget: "ready",
      } as never,
    ];
    host = render(createElement(ItemProperties), {
      slot: "conversation.properties.section",
      args: { conversationId: "conv-1" },
      queries: { "item.byConversation": () => ({ item }) },
      onAction: async (actionId, input) => {
        calls.push({ actionId, payload: input?.payload });
        return {};
      },
    });
    await flush();
    await click(buttonByText("Approve"));
    expect(calls).toEqual([
      {
        actionId: "gate.confirm",
        payload: { decisionId: "33333333-3333-4333-8333-333333333333", approve: true },
      },
    ]);
  });

  it("a decision the viewer may not answer has no answer buttons", async () => {
    const item = panelItem();
    item.openDecisions = [decision({ canAnswer: false })];
    host = render(createElement(ItemPanel), {
      slot: "conversation.panel",
      queries: { "item.byConversation": () => ({ item }) },
    });
    await flush();
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "OAuth",
    );
  });
});

describe("agent items", () => {
  it("lists the items the agent executes", async () => {
    host = render(createElement(AgentItems), {
      slot: "agent.detail.section",
      args: { agentId: MIA_AGENT.id },
      queries: {
        "agent.items": () => ({
          items: [
            {
              id: "i1",
              key: "APP-1",
              title: "Write the login page",
              projectKey: "APP",
              statusKey: "doing",
              statusName: { zh: "进行中", en: "Doing" },
              statusCategory: "in_progress",
              responsible: MIA,
              agentState: "working",
              updatedAt: "2026-11-28T08:00:00.000Z",
            },
          ],
        }),
      },
    });
    await flush();
    expect(host.queryCalls("agent.items")).toBe(1);
    const { lastProps } = await import("./fixtures.js");
    const rows = lastProps.ItemList?.rows as { title: string; href: string }[];
    expect(rows).toEqual([
      expect.objectContaining({
        title: "Write the login page",
        href: "/p/collab/projects?item=APP-1",
      }),
    ]);
  });
});
