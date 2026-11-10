import { readdirSync, readFileSync, renameSync, rmSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { LEGACY_WORKFLOW_FILENAME, parseWorkflowFile } from "../../shared/workflow-model.ts";
import { AgentWorkflowAccess } from "../agents/agent-workflow-enablement.ts";
import { GlobalWorkflowLibrary } from "./workflow-library.ts";
import { LEGACY_WORKFLOWS_DIRNAME } from "./workflow-store-contracts.ts";

export function migrateLegacyPerAgentWorkflows(agentDir: string, library: GlobalWorkflowLibrary, access: AgentWorkflowAccess): void {
  const previousFolder = join(agentDir, LEGACY_WORKFLOWS_DIRNAME);
  let candidates: Dirent[];
  try {
    candidates = readdirSync(previousFolder, { withFileTypes: true });
  } catch {
    return;
  }

  const enableIds: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.isDirectory()) continue;
    const id = candidate.name;
    const sourceFolder = join(previousFolder, id);

    if (!library.has(id)) {
      try {
        renameSync(sourceFolder, join(library.getLocation(), id));
      } catch {
        migrateFileIfUsable(sourceFolder, id, library);
      }
    }
    enableIds.push(id);
  }

  library.renameLegacyRecipeFiles();
  if (enableIds.length > 0) access.enableWorkflows(enableIds);
  rmSync(previousFolder, { recursive: true, force: true });
}

function migrateFileIfUsable(sourceFolder: string, id: string, library: GlobalWorkflowLibrary): void {
  let raw: string;
  try {
    raw = readFileSync(join(sourceFolder, LEGACY_WORKFLOW_FILENAME), "utf8");
  } catch {
    return;
  }

  const parsed = parseWorkflowFile(raw);
  if (parsed == null || parsed.body.length === 0) return;
  library.writeAt(id, {
    name: parsed.name || id,
    description: parsed.description,
    body: parsed.body,
    trigger: null,
  });
}
