import { join } from "node:path";

import { isSlateLocalToolAction, type SlateLocalToolAction } from "../../shared/local-tool-permission.ts";
import { getSlateRootDir } from "../host-paths.ts";

export const LOCAL_TOOL_APPROVALS_FILENAME = "local-tool-approvals.json";
export const LOCAL_TOOL_RETIREMENTS_FILENAME = "local-tool-retirements.json";

export interface LocalToolApproval {
  readonly id: string;
  readonly action: SlateLocalToolAction;
  readonly target: string;
  readonly resourcePath?: string;
}

export function getLocalToolApprovalsPath(): string {
  return join(getSlateRootDir(), LOCAL_TOOL_APPROVALS_FILENAME);
}

export function getLocalToolRetirementsPath(): string {
  return join(getSlateRootDir(), LOCAL_TOOL_RETIREMENTS_FILENAME);
}

export function parseApproval(value: unknown): LocalToolApproval | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return undefined;
  if (!isSlateLocalToolAction(row.action) || typeof row.target !== "string") return undefined;

  return {
    id: row.id,
    action: row.action,
    target: row.target,
    ...(typeof row.resourcePath === "string" ? { resourcePath: row.resourcePath } : {}),
  };
}
