import { readFileSync, statSync } from "node:fs";
import { parseWorkflowFile } from "../../shared/workflow-model.ts";
import { StatKeyedParseCache } from "./stat-keyed-parse-cache.ts";
import type { GlobalWorkflowRecord } from "./workflow-library-contracts.ts";

const recordsByFileSignature = new StatKeyedParseCache();

/** Parse a library entry only when the definition or containing directory changed. */
export function readGlobalWorkflowRecord(args: {
  readonly id: string;
  readonly definitionPath: string;
  readonly folderPath: string;
  readonly helperFiles: string[];
}): GlobalWorkflowRecord | null {
  return recordsByFileSignature.read(
    [args.definitionPath, args.folderPath],
    () => parseGlobalWorkflowFile(args),
  );
}

function parseGlobalWorkflowFile(args: {
  readonly id: string;
  readonly definitionPath: string;
  readonly folderPath: string;
  readonly helperFiles: string[];
}): GlobalWorkflowRecord | null {
  let contents: string;
  try {
    contents = readFileSync(args.definitionPath, "utf8");
  } catch {
    return null;
  }

  const workflow = parseWorkflowFile(contents);
  if (workflow == null || workflow.body.length === 0) return null;

  let createdAt = Date.now();
  try {
    const stats = statSync(args.definitionPath);
    createdAt = Math.floor(stats.birthtimeMs || stats.mtimeMs);
  } catch {
    // The parsed record is still useful when timestamp metadata is unavailable.
  }

  return {
    id: args.id,
    name: workflow.name || args.id,
    description: workflow.description,
    body: workflow.body,
    suggestedTrigger: workflow.trigger,
    sourceRef: workflow.sourceRef,
    helperScripts: args.helperFiles,
    createdAt,
    filePath: args.definitionPath,
  };
}
