import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { createProject } from "../domain/projects.js";
import { guarded, namesOf, optStr, personOf, str, type ToolDeps, writing } from "./common.js";
import { personLabel, result } from "./format.js";

/** Members listed per project in project_list. */
const MEMBERS_SHOWN = 30;

const PROJECT_LIST: ToolSpec = {
  name: "project_list",
  title: "List projects",
  description:
    "List the tracker projects you are a member of, with their keys, your role and their members.\n" +
    "Use it to find a project key before item_search or item_create, and to find the account id of " +
    "a member to assign work to. Archived projects are left out unless includeArchived is true.",
  inputSchema: {
    type: "object",
    properties: {
      includeArchived: {
        type: "boolean",
        description: "Also list archived projects (default false).",
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  defaultPolicy: "allow",
};

const PROJECT_CREATE: ToolSpec = {
  name: "project_create",
  title: "Create project",
  description:
    "Create a tracker project owned by your person, with the default item types (requirement, " +
    "task, bug) and their workflows.\n" +
    "Use it only when the user asks for a new project; to add work to an existing project use " +
    "item_create (call project_list first to check it does not exist yet).",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        pattern: "^[A-Z][A-Z0-9]{1,9}$",
        description:
          'The project key items are numbered under, 2 to 10 upper-case letters or digits, e.g. "CAP" (items become CAP-1, CAP-2, ...).',
      },
      name: { type: "string", maxLength: 200, description: 'The project name, e.g. "Reports".' },
      description: { type: "string", maxLength: 5000, description: "What the project is for." },
    },
    required: ["key", "name"],
    additionalProperties: false,
  },
  keyArgs: ["key", "name"],
  defaultPolicy: "ask",
};

/** Registers project_list and project_create. */
export function registerProjectTools(deps: ToolDeps): void {
  const { ctx, db } = deps;

  ctx.tools.register(
    PROJECT_LIST,
    guarded(async (input, call) => {
      const person = personOf(call);
      let query = db
        .selectFrom("projects as p")
        .innerJoin("project_members as m", (j) =>
          j.onRef("m.project_id", "=", "p.id").on("m.account_id", "=", person),
        )
        .select(["p.id", "p.key", "p.name", "p.description", "p.archived", "m.role"])
        .where("p.org_id", "=", call.orgId)
        .where("m.org_id", "=", call.orgId)
        .orderBy("p.key");
      if (input.includeArchived !== true) query = query.where("p.archived", "=", false);
      const projects = await query.execute();
      if (projects.length === 0) {
        return result(
          "You are not a member of any project. Ask a project owner to add your person, or create one with project_create.",
        );
      }
      const members = await db
        .selectFrom("project_members")
        .selectAll()
        .where("org_id", "=", call.orgId)
        .where(
          "project_id",
          "in",
          projects.map((p) => p.id),
        )
        .orderBy("created_at")
        .execute();
      const names = await namesOf(
        deps,
        call.orgId,
        members.map((m) => m.account_id),
      );
      const blocks = projects.map((p) => {
        const own = members.filter((m) => m.project_id === p.id);
        const lines = own.slice(0, MEMBERS_SHOWN).map((m) => {
          const extra = [
            m.function_label ? `function ${m.function_label}` : "",
            m.default_agent_id ? `default agent ${m.default_agent_id}` : "",
          ].filter(Boolean);
          return `  - ${personLabel(names, m.account_id)}: ${m.role}${extra.length ? ` (${extra.join(", ")})` : ""}`;
        });
        if (own.length > MEMBERS_SHOWN) lines.push(`  - … ${own.length - MEMBERS_SHOWN} more`);
        const head = `${p.key} "${p.name}"${p.archived ? " (archived)" : ""}; your role: ${p.role}`;
        const desc = p.description ? `\n  ${p.description.slice(0, 300)}` : "";
        return `${head}${desc}\n  Members:\n${lines.join("\n")}`;
      });
      return result(blocks.join("\n\n"), {
        zh: `列出 ${projects.length} 个项目`,
        en: `Listed ${projects.length} projects`,
      });
    }),
  );

  ctx.tools.register(
    PROJECT_CREATE,
    guarded(async (input, call) => {
      const description = optStr(input, "description");
      const project = await writing(deps, call, (actor) =>
        createProject(db, call.orgId, actor, {
          key: str(input, "key"),
          name: str(input, "name"),
          ...(description ? { description } : {}),
        }),
      );
      return result(
        `Created project ${project.key} "${project.name}" with the item types requirement, task and bug. Your person owns it; add members on the Projects page.`,
        { zh: `创建了项目 ${project.key}`, en: `Created project ${project.key}` },
      );
    }),
  );
}
