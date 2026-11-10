export const REMOTE_AGENT_ID_PREFIX = "slate-remote:";

export function parseRemoteAgentId(id: string): { ownerAuthId: string; agentId: string } | null {
  if (!id.startsWith(REMOTE_AGENT_ID_PREFIX)) return null;

  const encodedIdentity = id.slice(REMOTE_AGENT_ID_PREFIX.length);
  const separator = encodedIdentity.indexOf("/");
  if (separator <= 0 || separator === encodedIdentity.length - 1) return null;

  try {
    const ownerAuthId = decodeURIComponent(encodedIdentity.slice(0, separator));
    const agentId = decodeURIComponent(encodedIdentity.slice(separator + 1));
    return ownerAuthId.length > 0 && agentId.length > 0 ? { ownerAuthId, agentId } : null;
  } catch {
    return null;
  }
}
