import { AgentMode } from "../proto/generated/agent/v1/agent_pb.ts"

export type HostAgentMode = AgentMode

const MANAGED_CANVAS_PATH = /(?:^|\/)\.cursor\/projects\/[^/]+\/canvases\/[^/]+\.canvas\.tsx$/i

/** Read the host's planning mode at the external conversation boundary. */
export function isPlanMode(mode: HostAgentMode): boolean {
  return mode === AgentMode.PLAN
}

/** Recognize canvas files in the counterpart's managed project layout. */
export function isManagedCanvasEditPath(path: string): boolean {
  return MANAGED_CANVAS_PATH.test(path.trim().replace(/\\/g, "/"))
}
