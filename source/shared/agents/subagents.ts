const MANAGED_SUBAGENT_ID_MARKER = "slate-subagent-"

/** Identifies conversation ids allocated to subagents owned by this host. */
export function isManagedSubagentConversationId(id: string): boolean {
  return id.startsWith(MANAGED_SUBAGENT_ID_MARKER)
}
