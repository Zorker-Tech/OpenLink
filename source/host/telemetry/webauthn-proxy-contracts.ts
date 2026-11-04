export type SlateWebAuthnFailureCause =
  | "no_provider"
  | "provider_stale"
  | "dispatch_failed"
  | "timeout"
  | "consent_declined"
  | "sign_failed"
  | "desktop_failed";

export interface SlateWebAuthnObservation {
  outcome: string;
  stage: string;
  originClass: string;
  ceremonyKind: string;
  requestId: string;
  elapsedMs: number;
  providerCount?: number;
  liveProviderCount?: number;
  cause?: SlateWebAuthnFailureCause;
  rawDomErrorName?: string;
  rawSignErrorClass?: string;
}

export interface SlateWebAuthnTelemetryEntry {
  level: "warn" | "info";
  event: string;
  metadata: Record<string, string | undefined>;
}
