import { checkSyncedSkills } from "../synced-skills.js";
import { report, root } from "./report.js";

report("Synced skills", checkSyncedSkills(root));
