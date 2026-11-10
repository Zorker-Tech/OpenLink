/**
 * The agents a transcript shows, kept newest first: an agent that reports again replaces its own summary in place, and
 * an agent seen for the first time is added to the list.
 */
export interface AgentSummaryIdentity {
  readonly id: string;
  readonly updatedAt: number;
}

/** Newest first, by the time each agent last reported. */
export function compareAgentSummaries(left: AgentSummaryIdentity, right: AgentSummaryIdentity): number {
  return right.updatedAt - left.updatedAt;
}

export function upsertAgentSummary<Summary extends AgentSummaryIdentity>(entries: readonly Summary[], incoming: Summary): Summary[] {
  const isSameAgent = (entry: Summary): boolean => entry.id === incoming.id;
  if (!entries.some(isSameAgent)) return [...entries, incoming].sort(compareAgentSummaries);
  return entries.map((entry) => (isSameAgent(entry) ? incoming : entry)).sort(compareAgentSummaries);
}
