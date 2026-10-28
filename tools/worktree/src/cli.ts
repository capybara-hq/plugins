import { main } from "./worktree.js";

process.exitCode = main(process.argv.slice(2));
