/**
 * Agents that belong to somebody else.
 *
 * An agent can be shared, and a shared agent is referred to by its owner as well as by itself: the reference is written
 * into one id that carries both, so the id can be read back into the pair it names and a shared agent can be told from
 * a local one.
 */
export const REMOTE_AGENT_ID_PREFIX = "slate-remote:";
const AVATAR_DATA_URL_HEADERS = new Set([
  "data:image/png;base64",
  "data:image/jpeg;base64",
  "data:image/webp;base64",
  "data:image/gif;base64",
]);
const AVATAR_BASE64_CONTENT = /^[A-Za-z0-9+/]+={0,2}$/;

export interface RemoteAgentReference {
  readonly ownerAuthId: string;
  readonly agentId: string;
}

export function formatRemoteAgentId(ref: RemoteAgentReference): string {
  const ownerPart = encodeURIComponent(ref.ownerAuthId);
  const agentPart = encodeURIComponent(ref.agentId);
  return `${REMOTE_AGENT_ID_PREFIX}${ownerPart}/${agentPart}`;
}

export function isRemoteAgentId(id: string): boolean {
  return id.startsWith(REMOTE_AGENT_ID_PREFIX);
}

export function parseRemoteAgentId(id: string): RemoteAgentReference | null {
  if (!id.startsWith(REMOTE_AGENT_ID_PREFIX)) return null;
  const ownerEnd = id.indexOf("/", REMOTE_AGENT_ID_PREFIX.length);
  if (ownerEnd <= REMOTE_AGENT_ID_PREFIX.length || ownerEnd === id.length - 1) return null;
  try {
    const ownerAuthId = decodeURIComponent(id.slice(REMOTE_AGENT_ID_PREFIX.length, ownerEnd));
    const agentId = decodeURIComponent(id.slice(ownerEnd + 1));
    if (!ownerAuthId || !agentId) return null;
    return { ownerAuthId, agentId };
  } catch {
    return null;
  }
}

export const SLATE_SHARED_ROOM_IMAGE_BYTES_MAX = 1_100_000;
export const SLATE_SHARE_AVATAR_DATA_URL_MAX_LENGTH = 200_000;

export function isPublishableShareAvatarDataUrl(value: string): boolean {
  if (value.length > SLATE_SHARE_AVATAR_DATA_URL_MAX_LENGTH) return false;
  const comma = value.indexOf(",");
  if (comma < 0 || !AVATAR_DATA_URL_HEADERS.has(value.slice(0, comma))) return false;
  return AVATAR_BASE64_CONTENT.test(value.slice(comma + 1));
}

export const EMPTY_SLATE_SHARING_STATE = {
  isEnabled: false,
  selfAuthId: null,
  pendingJoinRequests: [],
  rooms: [],
  typingUsers: [],
} as const;
