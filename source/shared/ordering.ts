/** The keys a client's replicas are ordered and addressed by. */
export const ROSTER_REPLICA_KEY = "roster";

export function transcriptReplicaKey(agentId: string): string {
  return `transcript:${agentId}`;
}

export const ORDERED_REPLICAS_V1 = "orderedReplicasV1";
