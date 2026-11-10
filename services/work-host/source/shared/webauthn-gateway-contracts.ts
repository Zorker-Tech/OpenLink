/** Slate's own request and response frames for the security-key gateway. */

export const GATEWAY_WEBAUTHN_REQUESTS_PATH = "/webauthn/requests"
export const GATEWAY_WEBAUTHN_RESPONSES_PATH = "/webauthn/responses"

export const SLATE_WEBAUTHN_HEARTBEAT_INTERVAL_MS = 10_000
export const SLATE_WEBAUTHN_LIVENESS_WINDOW_MS = 30_000
export const SLATE_WEBAUTHN_CEREMONY_TIMEOUT_MS = 120_000

export const SLATE_NO_WEBAUTHN_MACHINE_MESSAGE =
  "This request needs the computer with the security key attached. Open Slate on the machine with the key and try again."

export const SLATE_WEBAUTHN_MACHINE_UNAVAILABLE_MESSAGE =
  "The computer that holds this security key is unreachable. Reconnect it, then retry the request."

export type WebAuthnCeremony = Readonly<Record<string, unknown>> & {
  readonly kind: string
  readonly origin: string
}

type RequestPayloadByKind = {
  readonly welcome: { readonly providerId: string }
  readonly ceremony: { readonly requestId: string; readonly ceremony: WebAuthnCeremony }
  readonly cancel: { readonly requestId: string }
}

type ResponsePayloadByKind = {
  readonly hello: { readonly computerId?: string; readonly label?: string }
  readonly ping: Record<never, never>
  readonly stage: {
    readonly requestId: string
    readonly stage: "grant" | "sign"
    readonly outcome: "ok" | "declined" | "failed"
  }
  readonly result: { readonly requestId: string; readonly credentialJson: unknown }
  readonly error: {
    readonly requestId: string
    readonly name: string
    readonly message: string
    readonly code?: string
  }
}

type TaggedFrames<PayloadByKind> = {
  [Kind in keyof PayloadByKind]: { readonly kind: Kind } & PayloadByKind[Kind]
}[keyof PayloadByKind]

export type WebAuthnRequestFrame = TaggedFrames<RequestPayloadByKind>
export type WebAuthnResponseFrame = TaggedFrames<ResponsePayloadByKind>
