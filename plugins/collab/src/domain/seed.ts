import type { CollabDb } from "../store/db.js";
import type { StatusCategory } from "../store/types.js";
import type { DefaultAssignmentRule, GateRule } from "./workflow.js";

interface SeedStatus {
  key: string;
  zh: string;
  en: string;
  category: StatusCategory;
  next: string[];
  gate?: GateRule;
  assign?: DefaultAssignmentRule;
}

interface SeedType {
  key: string;
  zh: string;
  en: string;
  icon: string;
  statuses: SeedStatus[];
}

/**
 * The item types and workflows a new project starts with (editable afterwards). A gate sits on
 * the status it guards entry into: "ready" waits on the project owner's review, a requirement's
 * "done" on the acceptance of the person who asked for it (not whoever became responsible, so
 * nobody accepts their own work by assigning it to themselves).
 */
// capybara:allow-module-state read-only constant
export const DEFAULT_TYPES: readonly SeedType[] = [
  {
    key: "requirement",
    zh: "需求",
    en: "Requirement",
    icon: "file-text",
    statuses: [
      {
        key: "backlog",
        zh: "待规划",
        en: "Backlog",
        category: "backlog",
        next: ["drafting", "canceled"],
      },
      {
        key: "drafting",
        zh: "编写中",
        en: "Drafting",
        category: "in_progress",
        next: ["review", "backlog", "canceled"],
      },
      {
        key: "review",
        zh: "待评审",
        en: "Review",
        category: "review",
        next: ["ready", "drafting", "canceled"],
      },
      {
        key: "ready",
        zh: "已就绪",
        en: "Ready",
        category: "todo",
        next: ["in_progress", "drafting", "canceled"],
        gate: { confirmer: "owner" },
        assign: { functionLabel: "engineering", memberAgent: true },
      },
      {
        key: "in_progress",
        zh: "开发中",
        en: "In progress",
        category: "in_progress",
        next: ["acceptance", "ready", "canceled"],
      },
      {
        key: "acceptance",
        zh: "待验收",
        en: "Acceptance",
        category: "review",
        next: ["done", "in_progress", "canceled"],
      },
      {
        key: "done",
        zh: "已完成",
        en: "Done",
        category: "done",
        next: ["in_progress"],
        gate: { confirmer: "requester" },
      },
      { key: "canceled", zh: "已取消", en: "Canceled", category: "canceled", next: ["backlog"] },
    ],
  },
  {
    key: "task",
    zh: "任务",
    en: "Task",
    icon: "square-check",
    statuses: [
      {
        key: "todo",
        zh: "待处理",
        en: "To do",
        category: "todo",
        next: ["in_progress", "canceled"],
      },
      {
        key: "in_progress",
        zh: "进行中",
        en: "In progress",
        category: "in_progress",
        next: ["testing", "todo", "canceled"],
      },
      {
        key: "testing",
        zh: "待测试",
        en: "Testing",
        category: "review",
        next: ["done", "in_progress", "canceled"],
        assign: { functionLabel: "qa", memberAgent: true },
      },
      { key: "done", zh: "已完成", en: "Done", category: "done", next: ["in_progress"] },
      { key: "canceled", zh: "已取消", en: "Canceled", category: "canceled", next: ["todo"] },
    ],
  },
  {
    key: "bug",
    zh: "缺陷",
    en: "Bug",
    icon: "bug",
    statuses: [
      {
        key: "open",
        zh: "待修复",
        en: "Open",
        category: "todo",
        next: ["fixing", "wont_fix"],
        assign: { functionLabel: "engineering", memberAgent: true },
      },
      {
        key: "fixing",
        zh: "修复中",
        en: "Fixing",
        category: "in_progress",
        next: ["verifying", "open", "wont_fix"],
      },
      {
        key: "verifying",
        zh: "待验证",
        en: "Verifying",
        category: "review",
        next: ["closed", "fixing"],
        assign: { functionLabel: "qa", memberAgent: true },
      },
      { key: "closed", zh: "已关闭", en: "Closed", category: "done", next: ["open"] },
      { key: "wont_fix", zh: "不修复", en: "Won't fix", category: "canceled", next: ["open"] },
    ],
  },
];

/** Writes the default item types and their workflows into a new project (inside its transaction). */
export async function seedProject(db: CollabDb, orgId: string, projectId: string): Promise<void> {
  for (const type of DEFAULT_TYPES) {
    const workflow = await db
      .insertInto("workflows")
      .values({ org_id: orgId, project_id: projectId, item_type: type.key })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("statuses")
      .values(
        type.statuses.map((s, position) => ({
          org_id: orgId,
          workflow_id: workflow.id,
          key: s.key,
          name_zh: s.zh,
          name_en: s.en,
          category: s.category,
          position,
          next_keys: s.next,
          gate: s.gate ? JSON.stringify(s.gate) : null,
          default_assignment: s.assign ? JSON.stringify(s.assign) : null,
        })),
      )
      .execute();
    await db
      .insertInto("item_types")
      .values({
        org_id: orgId,
        project_id: projectId,
        key: type.key,
        name_zh: type.zh,
        name_en: type.en,
        icon: type.icon,
        workflow_id: workflow.id,
      })
      .execute();
  }
}
