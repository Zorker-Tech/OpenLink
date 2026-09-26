/**
 * The gateway paths a security-key request travels over, and what to say when the machine holding the key is not there.
 *
 * The key is a physical thing plugged into one of the user's machines, so a request that cannot reach that machine is
 * reported as such rather than as a failure of the key, and the heartbeat interval is how often the desktop says it is
 * still there. An origin is classified by whose it is, so a request can be told apart from one made somewhere else.
 */
/** The domain the platform's own gateways are served from; a placeholder until the real one exists. */
export const SLATE_ORIGIN_DOMAIN = "slate.invalid";

export const GATEWAY_WEBAUTHN_REQUESTS_PATH = "/webauthn/requests";
export const GATEWAY_WEBAUTHN_RESPONSES_PATH = "/webauthn/responses";
export const SLATE_WEBAUTHN_HEARTBEAT_INTERVAL_MS = 10_000;

export const SLATE_NO_WEBAUTHN_MACHINE_MESSAGE =
  "Your computer isn't connected right now, so the security key can't be reached. Open Slate on the machine your key is plugged into and try again.";

export const SLATE_WEBAUTHN_MACHINE_UNAVAILABLE_MESSAGE =
  "Your computer looks disconnected, so the security key can't be reached. Reconnect it and try again.";

export const SLATE_WEBAUTHN_LIVENESS_WINDOW_MS = 30_000;
export const SLATE_WEBAUTHN_CEREMONY_TIMEOUT_MS = 120_000;

export type SlateWebAuthnOriginClass = "apex" | "subdomain" | "external";

export function slateWebAuthnOriginClass(origin: string): SlateWebAuthnOriginClass {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return "external";
  }
  if (hostname === SLATE_ORIGIN_DOMAIN) return "apex";
  return hostname.endsWith(`.${SLATE_ORIGIN_DOMAIN}`) ? "subdomain" : "external";
}

export interface WebAuthnCeremony {
  readonly kind: string;
  readonly origin: string;
  readonly [key: string]: unknown;
}

export type WebAuthnRequestFrame =
  | { readonly kind: "welcome"; readonly providerId: string }
  | { readonly kind: "ceremony"; readonly requestId: string; readonly ceremony: WebAuthnCeremony }
  | { readonly kind: "cancel"; readonly requestId: string };

export type WebAuthnResponseFrame =
  | { readonly kind: "hello"; readonly computerId?: string; readonly label?: string }
  | { readonly kind: "ping" }
  | { readonly kind: "stage"; readonly requestId: string; readonly stage: "grant" | "sign"; readonly outcome: "ok" | "declined" | "failed" }
  | { readonly kind: "result"; readonly requestId: string; readonly credentialJson: unknown }
  | { readonly kind: "error"; readonly requestId: string; readonly name: string; readonly message: string; readonly code?: string };
