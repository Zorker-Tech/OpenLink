export const SNAPSHOT_TIMEOUT_MS = 5_000;
export const MAX_DOMAIN_LENGTH = 64;

export interface HandoffRequest {
  agentId: string;
  instruction: string;
  telemetry?: { reason?: string; domain?: string; idpDomain?: string };
}

export interface PendingHandoff {
  requestId: string;
  instruction: string;
  snapshotDataUrl?: string;
}

export type HandoffTrigger = { resolution?: "completed" | "cancelled"; trigger?: string } | string;

export interface BoxHandoffDeps {
  grabScreenshot?(agentId: string): Promise<string | Uint8Array | null>;
  prepare?(agentId: string, request: Record<string, unknown>): Promise<void>;
  onStarted?(event: { agentId: string; instruction: string }): void;
  onEnded?(event: { agentId: string; requestId: string; resolution: string; trigger: string }): void | Promise<void>;
  onStatusChanged?(agentId: string): void;
  telemetry?: {
    reportBoxHelp(event: Record<string, unknown>): void;
    trackEvent(name: string, properties: Record<string, unknown>): void;
  };
  report?(event: Record<string, unknown>): void;
  timeoutMs?: number;
}
