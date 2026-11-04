import { ToolCallRejectedError } from "../../tool-errors.ts"

const MARKDOWN_SUFFIXES = [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx"]

export function isMarkdownEditPath(path: string): boolean {
  const normalized = path.trim().toLowerCase()
  return MARKDOWN_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

export function isPlanModeAllowedEditPath(path: string, isManagedCanvas = false): boolean {
  return isMarkdownEditPath(path) || isManagedCanvas
}

export const PLAN_MODE_NON_MARKDOWN_EDIT_ERROR = "Cannot edit non markdown files in plan mode"

export function assertPlanModeAllowsFileEdit(path: string, isPlanMode: boolean, isManagedCanvas = false): void {
  if (!isPlanMode || isPlanModeAllowedEditPath(path, isManagedCanvas)) return
  throw new ToolCallRejectedError(PLAN_MODE_NON_MARKDOWN_EDIT_ERROR)
}
