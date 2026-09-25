/**
 * Reading the kind of run out of whatever was stored.
 *
 * The kind is persisted and travels through config, so it arrives as a string that may name a run kind
 * this build does not know — an older session, a newer one, or a typo. Only the four kinds the platform
 * has are accepted, and anything else is reported as unknown rather than passed through, because a
 * caller that switches on the kind needs the set to be closed.
 */

import { AgentType } from "./utils/agent-config.ts"

export function parseAgentType(agentType: AgentType | string | undefined): AgentType | undefined {
  switch (agentType) {
    case AgentType.IDE:
    case AgentType.CLI:
    case AgentType.BACKGROUND:
    case AgentType.BUGBOT:
      return agentType
    case undefined:
      return undefined
    default:
      return undefined
  }
}
