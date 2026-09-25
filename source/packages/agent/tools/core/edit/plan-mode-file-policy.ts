/**
 * What plan mode may edit.
 *
 * Plan mode exists so the agent can work out what to do before doing it, and the way it is kept honest is
 * by refusing edits — except the two kinds that are the planning rather than the work: markdown, which is
 * where a plan is written, and the platform's own canvas files, which are how a plan is drawn. Everything
 * else is refused with an explanation rather than a silent failure, because a model that is told why will
 * write the plan instead of trying again.
 */

import { AgentMode } from "../../../../proto/generated/agent/v1/agent_pb.ts"
import { ToolCallRejectedError } from "../../tool-errors.ts"

const MARKDOWN_SUFFIXES = [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx"]
const MANAGED_CANVAS_REGEX = /(?:^|\/)\.cursor\/projects\/[^/]+\/canvases\/[^/]+\.canvas\.tsx$/i

export function isMarkdownEditPath(path: string): boolean {
  const normalized = path.trim().toLowerCase()
  return MARKDOWN_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

export function isManagedCanvasEditPath(path: string): boolean {
  return MANAGED_CANVAS_REGEX.test(path.trim().replace(/\\/g, "/"))
}

export function isPlanModeAllowedEditPath(path: string): boolean {
  return isMarkdownEditPath(path) || isManagedCanvasEditPath(path)
}

export const PLAN_MODE_NON_MARKDOWN_EDIT_ERROR = "Cannot edit non markdown files in plan mode"

export interface PlanModeState {
  readonly mode: AgentMode
}

export function assertPlanModeAllowsFileEdit(path: string, stateHandler: PlanModeState): void {
  if (stateHandler.mode !== AgentMode.PLAN || isPlanModeAllowedEditPath(path)) return
  throw new ToolCallRejectedError(PLAN_MODE_NON_MARKDOWN_EDIT_ERROR)
}
