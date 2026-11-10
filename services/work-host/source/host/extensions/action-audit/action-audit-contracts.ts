import type { PollingPolicy } from "../scheduling.ts";

export const ACTION_AUDIT_FLUSH_INTERVAL_MS = 5_000;
export const MAX_AUDIT_BATCH_SIZE = 50;
export const MAX_PENDING_AUDIT_EVENTS = 2_000;
export const AUDIT_FLUSH_FAILURE_BACKOFF_MS = 30_000;

export type AuditAction =
  | {
      readonly kind: "mcpToolCall";
      readonly toolCallId: string;
      readonly serverIdentifier: string;
      readonly serverName?: string;
      readonly toolName: string;
      readonly transport: string;
      readonly status: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "shellCommand";
      readonly command: string;
      readonly shellKind: string;
      readonly target: string;
      readonly allowed?: boolean;
      readonly blockedReason?: string;
      readonly classificationReasons?: string[];
    }
  | { readonly kind: "browserNavigation"; readonly url: string; readonly pageTitle: string }
  | {
      readonly kind: "computerUseSession";
      readonly toolCallId?: string;
      readonly actionCount: number;
      readonly actionCounts: Record<string, number>;
      readonly durationMs: number;
      readonly screenshotCount: number;
    };

export interface AuditRecord {
  readonly occurredAtMs: number;
  readonly agentId: string;
  readonly turnId?: string;
  readonly boxId?: string;
  readonly action: AuditAction;
}

export interface AuditEvent extends AuditRecord {
  readonly eventId: string;
  readonly turnId: string;
  readonly boxId: string;
}

export interface ActionAuditDependencies {
  readonly isBackendForwardingEnabled: () => boolean | Promise<boolean>;
  readonly sendBatch: (events: readonly AuditEvent[]) => Promise<void>;
  readonly flushPolicy: PollingPolicy;
  readonly report?: (diagnostic: unknown) => void;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly outboxPath?: string;
  readonly auditPath?: (agentId: string) => string;
  readonly appendLocalLine?: (path: string, line: string) => Promise<void>;
}
