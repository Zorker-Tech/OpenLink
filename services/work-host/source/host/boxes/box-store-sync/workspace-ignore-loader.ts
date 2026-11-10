import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REGENERABLE_WORKSPACE_PATH_PATTERNS } from "../../../adapters/interop/box/workspace-archive-layout-adapter.ts";
import { WORKSPACE_IGNORE_FILE_NAME } from "../../../packages/constants/box-archive.ts";
import type { WorkspaceIgnore } from "./workspace-ignore-contracts.ts";
import { compileWorkspaceIgnore } from "./workspace-ignore-policy.ts";
import { parseIgnorePatterns } from "./workspace-ignore-patterns.ts";

/** Combine the workspace's additions with the archive defaults; an unreadable file contributes no rules. */
export function loadWorkspaceIgnore(
  workspaceDir: string,
  defaults: readonly string[] = REGENERABLE_WORKSPACE_PATH_PATTERNS,
): WorkspaceIgnore {
  const patterns = [...defaults];
  try {
    const localText = readFileSync(join(workspaceDir, WORKSPACE_IGNORE_FILE_NAME), "utf8");
    patterns.push(...parseIgnorePatterns(localText));
  } catch {
    // A missing or unreadable optional file leaves the built-in policy in force.
  }
  return compileWorkspaceIgnore(patterns);
}
