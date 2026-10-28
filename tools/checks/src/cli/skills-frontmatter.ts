import { join } from "node:path";
import { checkSkillsFrontmatter } from "../skills-frontmatter.js";
import { report, root } from "./report.js";

report("Skills frontmatter", checkSkillsFrontmatter(join(root, ".agents/skills")));
