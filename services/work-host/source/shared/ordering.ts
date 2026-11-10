/** The keys a client's replicas are ordered and addressed by. */
export const ORDERED_REPLICAS_V1 = "orderedReplicasV1";

/** The key a conversation's roster is a replica of. */
export const ROSTER_REPLICA_KEY = "roster";

/** The key one agent's transcript is a replica of. */
export function transcriptReplicaKey(agent: string): string {
  return "transcript:" + agent;
}
