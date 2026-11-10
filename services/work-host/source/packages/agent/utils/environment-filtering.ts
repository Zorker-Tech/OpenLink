/**
 * Which rules, skills and plugins a run is allowed to see, by the environment it runs in.
 *
 * A bug_report run is not scoped at all: it works on the codebase as it is and has no environment to
 * belong to. Every other kind of run has one — the cloud is not a developer's machine — and the items
 * that were written for a different one are dropped rather than shown and then refused.
 */

import { AgentType } from "./agent-config.ts"
import { filterByEnvironment, type EnvironmentScopedItem } from "../../plugins/environment-filter.ts"

export function filterItemsForRunEnvironment<T extends EnvironmentScopedItem>(items: T[], agentType?: AgentType): T[] {
  if (agentType === undefined || agentType === AgentType.BUGBOT) return items
  const environment = agentType === AgentType.BACKGROUND ? "cloud" : "local"
  return filterByEnvironment(items, environment)
}
