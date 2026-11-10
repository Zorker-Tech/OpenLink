/** Where the platform keeps what it manages for a project: its own copies of projects and worktrees. */
import { homedir } from "node:os";
import { join } from "node:path";
export const SLATE_PROJECTS_ROOT = join(homedir(), ".slate", "projects");
export const SLATE_WORKTREES_ROOT = join(homedir(), ".slate", "worktrees");
