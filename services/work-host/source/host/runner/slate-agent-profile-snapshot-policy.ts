import type { AgentProfileIdentity, AgentProfilePromptSnapshot } from "./slate-agent-profile-prompt-contracts.ts"

export function resolveAgentProfilePromptSnapshot(input: {
  snapshot?: AgentProfilePromptSnapshot
  compactionEpoch: number
  profileSection: string
  identity: AgentProfileIdentity
}): AgentProfilePromptSnapshot {
  if (input.snapshot?.compactionEpoch === input.compactionEpoch) return input.snapshot
  return {
    version: 1,
    profileSection: input.profileSection,
    systemIdentity: input.identity,
    announcedIdentity: input.identity,
    compactionEpoch: input.compactionEpoch,
  }
}
