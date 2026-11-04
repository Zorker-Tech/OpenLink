import { readdirSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_WORKFLOW_FILENAME, WORKFLOW_FILENAME } from "../../shared/workflow-model.ts";

const NON_HELPER_FILES = new Set([WORKFLOW_FILENAME, LEGACY_WORKFLOW_FILENAME, "runs.json"]);

export function getGlobalWorkflowsDir(slateRoot: string): string {
  return join(slateRoot, "workflows");
}

export function workflowFolderPath(libraryDir: string, id: string): string {
  return join(libraryDir, id);
}

export function workflowFilePath(libraryDir: string, id: string): string {
  return join(workflowFolderPath(libraryDir, id), WORKFLOW_FILENAME);
}

/** List directory names, not files, in the ordering used by the library. */
export function listWorkflowFolderIds(libraryDir: string): string[] {
  try {
    return readdirSync(libraryDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Return only ordinary helper files, sorted for stable prompt and publish projections. */
export function listWorkflowHelperFiles(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !NON_HELPER_FILES.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
