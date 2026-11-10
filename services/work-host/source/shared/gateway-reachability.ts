/**
 * Whether a gateway can be reached, and what to do about it when it cannot.
 *
 * A gateway that is not there yet, or that has gone away, is not the same as one that refused the request, and the
 * difference decides whether a caller waits, retries or reports — which is what the policy here is for.
 */
export const CLOUD_AGENT_STORAGE_DISABLED = "CLOUD_AGENT_STORAGE_DISABLED";
export const GATEWAY_NO_STORAGE_MESSAGE_MARKER = "slate box access blocked by privacy mode (no_storage)";
export const GATEWAY_ACCESS_DENIED_MESSAGE_MARKER = "slate box access refused by backend access gate (access_denied)";
export const SLATE_BOX_BLOCKED = "SLATE_BOX_BLOCKED";
export const SLATE_BOX_BLOCK_REASON_KEY = "slateBoxBlockReason";
export const GATEWAY_BOX_BLOCKED_PREFIX = "slate box blocked by kill switch: ";
const BOX_BLOCKED_FIELD_SEPARATOR = String.fromCharCode(31);

export interface BoxBlockedInfo {
  reason: string;
  title: string;
  detail: string;
}

export function encodeBoxBlockedMessage(info: BoxBlockedInfo): string {
  const details = [info.reason, info.title, info.detail].join(BOX_BLOCKED_FIELD_SEPARATOR);
  return GATEWAY_BOX_BLOCKED_PREFIX + details;
}

function suffixAtBlockedMarker(message: string): string | null {
  const marker = message.indexOf(GATEWAY_BOX_BLOCKED_PREFIX);
  return marker < 0 ? null : message.slice(marker);
}

export function hasBoxBlockedMarker(message: string): boolean {
  return suffixAtBlockedMarker(message) !== null;
}

export const SLATE_CLIENT_PAUSE_REASON = "SLATE_CLIENT_PAUSE";
export const SLATE_CLIENT_PAUSE_BLOCKED_MESSAGE = encodeBoxBlockedMessage({
  reason: SLATE_CLIENT_PAUSE_REASON,
  title: "",
  detail: ""
});

export function findBoxBlockedMessage(error: unknown): string | null {
  const visited = new Set<object>();
  let cause = error;
  while (cause !== null && typeof cause === "object" && !visited.has(cause)) {
    visited.add(cause);
    const record = cause as { readonly message?: unknown; readonly cause?: unknown };
    if (typeof record.message === "string") {
      const blockedMessage = suffixAtBlockedMarker(record.message);
      if (blockedMessage !== null) return blockedMessage;
    }
    cause = record.cause;
  }
  return null;
}
