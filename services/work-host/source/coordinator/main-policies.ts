import { createRealRetryPolicy } from "../host/extensions/scheduling.ts"
import { HOST_ACCOUNT_SLOT } from "./gateway/gateway-client.ts"

export interface PendingMcpAuthorization {
  readonly serverName: string
  readonly redirectUrl: string
  readonly state: string
}

/** Accept a redirect only when all values needed to complete the authorization round-trip are present. */
export function parsePendingMcpAuthorization(value: unknown): PendingMcpAuthorization | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const fields = value as Record<string, unknown>
  const { serverName, redirectUrl, state } = fields
  return typeof serverName === "string" && serverName !== "" &&
      typeof redirectUrl === "string" && redirectUrl !== "" &&
      typeof state === "string" && state !== ""
    ? { serverName, redirectUrl, state }
    : undefined
}

/** A user-authored transcript entry carrying this turn's nonce confirms that the send landed. */
export function recordTranscriptEcho(
  value: unknown,
  recorder: { recordSendEcho(key: { accountSlot: string; clientNonce: string }): void },
): void {
  if (typeof value !== "object" || value === null) return
  const event = value as { readonly type?: unknown; readonly entry?: Record<string, unknown> }
  const entry = event.type === "appended" ? event.entry : undefined
  if (typeof entry?.clientNonce !== "string" || entry.clientNonce === "") return
  const authoredByUser = entry.kind === "user-attachment" ||
    (entry.kind === "message" && entry.role === "user")
  if (authoredByUser) recorder.recordSendEcho({ accountSlot: HOST_ACCOUNT_SLOT, clientNonce: entry.clientNonce })
}

export function webAuthnReconnectSchedule() {
  return createRealRetryPolicy({
    name: "slate-webauthn-reconnect",
    maxAttempts: Number.MAX_SAFE_INTEGER,
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
  })
}
