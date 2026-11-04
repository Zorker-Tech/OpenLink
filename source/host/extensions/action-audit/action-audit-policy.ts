import { getSlateRetryAfterMs, isSlateRateLimitError } from "../../../shared/network/remote-rpc-error.ts";
import { AUDIT_FLUSH_FAILURE_BACKOFF_MS } from "./action-audit-contracts.ts";
import type { AuditRecord } from "./action-audit-contracts.ts";

/** Keep a conservative retry floor, while respecting a longer server rate-limit request. */
export function flushFailureBackoffMs(error: unknown, nowMs: number): number {
  if (!isSlateRateLimitError(error)) return AUDIT_FLUSH_FAILURE_BACKOFF_MS;
  return Math.max(getSlateRetryAfterMs(error, nowMs) ?? 0, AUDIT_FLUSH_FAILURE_BACKOFF_MS);
}

/** Standard MCP transports stay local; stdio actions may be sent with the audit batch. */
export function isBackendForwardable(record: AuditRecord): boolean {
  return record.action.kind !== "mcpToolCall" || record.action.transport === "stdio";
}
