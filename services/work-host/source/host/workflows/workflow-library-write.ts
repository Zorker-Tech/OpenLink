import { readFileSync } from "node:fs";
import { serializeWorkflowFile, parseWorkflowFile } from "../../shared/workflow-model.ts";
import type { WorkflowSpec } from "../../shared/workflow-model.ts";
import type { WatchedDirectory } from "../watched-directory.ts";

function storedFrontmatter(definitionPath: string): Record<string, unknown> {
  try {
    return parseWorkflowFile(readFileSync(definitionPath, "utf8"))?.data ?? {};
  } catch {
    return {};
  }
}

/** Write a definition atomically while carrying forward metadata this library does not own. */
export function writeGlobalWorkflowRecord(
  directory: WatchedDirectory,
  definitionPath: string,
  spec: WorkflowSpec,
): void {
  const frontmatter = storedFrontmatter(definitionPath);
  directory.writeFileAtomic(definitionPath, serializeWorkflowFile(spec, frontmatter));
}
