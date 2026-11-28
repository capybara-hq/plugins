import {
  type FakeHost,
  type FakeHostOptions,
  renderWithFakeHost,
} from "@capybara-hq/plugin-client/testing";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import type {
  AgentRef,
  BoardCard,
  DecisionRow,
  ItemDetailResult,
  PanelItem,
  PersonRef,
  ProjectBoardResult,
  ProjectHeader,
  ProjectsListResult,
  StatusInfo,
} from "../../src/page/contract.js";

export const MIA: PersonRef = { id: "acc-mia", name: "Mia", avatar: null };
export const BEN: PersonRef = { id: "acc-ben", name: "Ben", avatar: null };
export const MIA_AGENT: AgentRef = { id: "agent-mia", name: "Mia's coder", avatar: null };
export const BEN_AGENT: AgentRef = { id: "agent-ben", name: "Ben's tester", avatar: null };

export const PROJECT: ProjectHeader = {
  id: "11111111-1111-4111-8111-111111111111",
  key: "APP",
  name: "App",
  description: "The app",
  archived: false,
  role: "owner",
  owner: MIA,
};

export const STATUSES: StatusInfo[] = [
  {
    key: "open",
    name: { zh: "待处理", en: "Open" },
    category: "todo",
    next: [],
    gate: null,
    defaultAssignment: null,
  },
  {
    key: "ready",
    name: { zh: "就绪", en: "Ready" },
    category: "todo",
    next: [],
    gate: { confirmer: "owner" },
    defaultAssignment: null,
  },
  {
    key: "doing",
    name: { zh: "进行中", en: "Doing" },
    category: "in_progress",
    next: [],
    gate: null,
    defaultAssignment: null,
  },
];

export const TYPES = [
  { key: "task", name: { zh: "任务", en: "Task" }, icon: null },
  { key: "bug", name: { zh: "缺陷", en: "Bug" }, icon: null },
];

export function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    key: "APP-1",
    title: "Write the login page",
    statusKey: "open",
    priority: 3,
    labels: [],
    version: 4,
    responsible: MIA,
    agent: MIA_AGENT,
    agentState: "working",
    parentKey: null,
    openDecisions: 0,
    pendingGate: null,
    updatedAt: "2026-11-28T08:00:00.000Z",
    ...over,
  };
}

export function boardResult(over: Partial<ProjectBoardResult> = {}): ProjectBoardResult {
  return {
    project: PROJECT,
    types: TYPES,
    type: "task",
    columns: STATUSES.map((s) => ({ ...s, locked: s.gate !== null })),
    cards: [card()],
    truncated: false,
    canEdit: true,
    ...over,
  };
}

export const PROJECTS_LIST: ProjectsListResult = {
  canCreate: true,
  projects: [
    {
      id: PROJECT.id,
      key: "APP",
      name: "App",
      description: "The app",
      archived: false,
      role: "owner",
      owner: MIA,
      openItems: 3,
    },
  ],
};

export function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "question",
    question: "Use OAuth or passwords?",
    options: [
      { id: "oauth", label: "OAuth" },
      { id: "password", label: "Passwords" },
    ],
    recommendation: { optionId: "oauth", why: "Fewer secrets" },
    blocking: true,
    state: "open",
    asker: { person: MIA, agent: MIA_AGENT },
    addressee: MIA,
    answer: null,
    gateTarget: null,
    deadlineAt: null,
    createdAt: "2026-11-28T08:00:00.000Z",
    answeredAt: null,
    canAnswer: true,
    ...over,
  };
}

export function detailResult(): ItemDetailResult {
  return {
    project: PROJECT,
    item: {
      id: card().id,
      key: "APP-1",
      type: "task",
      title: "Write the login page",
      description: "Login with **OAuth**",
      statusKey: "open",
      priority: 3,
      labels: ["web"],
      version: 4,
      requester: MIA,
      responsible: MIA,
      agent: MIA_AGENT,
      agentState: "working",
      agentStateAt: null,
      agentConversationId: null,
      closedAt: null,
      createdAt: "2026-11-27T08:00:00.000Z",
      updatedAt: "2026-11-28T08:00:00.000Z",
    },
    type: TYPES[0] as ItemDetailResult["type"],
    statuses: STATUSES,
    parent: null,
    children: [],
    links: [],
    artifacts: [],
    decisions: [decision()],
    canEdit: true,
    watching: false,
  };
}

export function panelItem(): PanelItem {
  return {
    id: card().id,
    key: "APP-1",
    title: "Write the login page",
    projectKey: "APP",
    projectName: "App",
    type: TYPES[0] as PanelItem["type"],
    statusKey: "open",
    statusName: { zh: "待处理", en: "Open" },
    statusCategory: "todo",
    priority: 3,
    labels: [],
    version: 4,
    responsible: MIA,
    agent: MIA_AGENT,
    agentState: "working",
    openDecisions: [decision()],
    canEdit: true,
  };
}

/** The four page templates the host counts for a `frame: "page"` component. */
export const TEMPLATES = ["ListPage", "DetailPage", "FormPage", "SettingsPage"];

export function templateCount(): number {
  return TEMPLATES.reduce(
    (n, name) => n + document.querySelectorAll(`[data-fake-design="${name}"]`).length,
    0,
  );
}

type Design = Record<string, (props: Record<string, unknown>) => ReactNode>;

function hostDesign(): Design {
  const host = (globalThis as Record<string, unknown>).__CAPYBARA_CLIENT_HOST__ as {
    design: Design;
  };
  return host.design;
}

/**
 * Props the stand-ins received, by component name (the last render's): the fake host's design
 * components are wrapped so tests can read what the plugin passed (locked columns, onMove).
 */
export const lastProps: Record<string, Record<string, unknown>> = {};

const TEXT_PROPS: Record<string, string> = {
  CellTitle: "title",
  ItemListItem: "title",
  Markdown: "text",
  PersonName: "name",
};

/** Clickable buttons (the fake host's Button is a span without onClick). */
function installRicherDesign(): void {
  const design = hostDesign();
  const wrapped: Design = {};
  for (const [name, Stub] of Object.entries(design)) {
    wrapped[name] = (props) => {
      lastProps[name] = props;
      return Stub(props);
    };
  }
  // stand-ins that show their text props, so tests read what a person would see
  for (const [name, prop] of Object.entries(TEXT_PROPS)) {
    wrapped[name] = (p) => {
      lastProps[name] = p;
      return createElement(
        "span",
        { "data-fake-design": name },
        String(p[prop] ?? ""),
        p.children as ReactNode,
        // an item's trailing actions (buttons), as a person would see them
        (p.actions ?? null) as ReactNode,
      );
    };
  }
  wrapped.Button = (p) => {
    lastProps.Button = p;
    return createElement(
      "button",
      {
        type: "button",
        onClick: p.onClick as () => void,
        disabled: p.disabled as boolean | undefined,
        "aria-label": p["aria-label"] as string | undefined,
        "data-fake-design": "Button",
      },
      p.children as ReactNode,
    );
  };
  const host = (globalThis as Record<string, unknown>).__CAPYBARA_CLIENT_HOST__ as {
    design: Design;
  };
  host.design = wrapped;
}

export function render(element: ReactElement, options: FakeHostOptions): FakeHost {
  for (const k of Object.keys(lastProps)) delete lastProps[k];
  const host = renderWithFakeHost(element, { plugin: "collab", locale: "en", ...options });
  installRicherDesign();
  host.rerender();
  return host;
}

/** Lets the fake queries (resolved in a microtask) and state updates run. */
export const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

export const text = () => document.body.textContent ?? "";

export function buttonByText(label: string): HTMLButtonElement {
  const b = [...document.querySelectorAll("button")].find(
    (x) => x.textContent === label || x.getAttribute("aria-label") === label,
  );
  if (b === undefined) throw new Error(`no button "${label}"`);
  return b;
}

export async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}
