/** Reduce persisted run metadata to the agent kinds this build understands. */

import { AgentType } from "./utils/agent-config.ts"

const RECOGNIZED_AGENT_TYPES = new Set<string>(Object.values(AgentType))

export function resolveAgentType(value: unknown): AgentType | undefined {
  if (typeof value !== "string" || !RECOGNIZED_AGENT_TYPES.has(value)) return undefined
  return value as AgentType
}
