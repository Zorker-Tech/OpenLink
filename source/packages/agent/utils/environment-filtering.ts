/**
 * Which rules, skills and plugins a run is allowed to see, by the environment it runs in.
 *
 * A bug_report run is not scoped at all: it works on the codebase as it is and has no environment to
 * belong to. Every other kind of run has one — the cloud is not a developer's machine — and the items
 * that were written for a different one are dropped rather than shown and then refused.
 */

import { AgentType } from "./agent-config.ts"
import { filterByEnvironment, type EnvironmentScopedItem } from "../../plugins/environment-filter.ts"

const ENVIRONMENT_BY_AGENT_TYPE: Record<AgentType, string> = {
  [AgentType.BACKGROUND]: "cloud",
  [AgentType.BUGBOT]: "local",
  [AgentType.IDE]: "local",
  [AgentType.CLI]: "local",
}

export function filterByAgentEnvironment<T extends EnvironmentScopedItem>(items: T[], agentType?: AgentType): T[] {
  if (agentType === undefined || agentType === AgentType.BUGBOT) return items
  return filterByEnvironment(items, ENVIRONMENT_BY_AGENT_TYPE[agentType])
}
