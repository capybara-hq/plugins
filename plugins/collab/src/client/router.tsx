import { usePageParams } from "@capybara-hq/plugin-client";
import { ProjectBoard, useProjectFilter } from "./board.js";
import { ItemDetail } from "./item-detail.js";
import { ItemsTable } from "./items-table.js";
import { ProjectsList } from "./projects-list.js";
import { Settings } from "./settings.js";

/**
 * The project pages (`org.page` "projects"): one route per page params, each drawing exactly one
 * page template.
 * - none: the projects list;
 * - `item=KEY-n`: the item page;
 * - `project=KEY&settings=1`: the project settings;
 * - `project=KEY` (`view=board|list`, default board): the board or the item table.
 */
export function ProjectsPage() {
  const params = usePageParams();
  if (params.item !== undefined) return <ItemDetail key={params.item} itemKey={params.item} />;
  const project = params.project;
  if (project === undefined) return <ProjectsList />;
  if (params.settings === "1") return <Settings project={project} />;
  if (params.view === "list") return <ProjectList project={project} />;
  return <ProjectBoard project={project} />;
}

function ProjectList({ project }: { project: string }) {
  const { type, filter } = useProjectFilter();
  return <ItemsTable project={project} type={type} filter={filter} />;
}
