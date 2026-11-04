/** Contracts for approvals that must survive after an MCP call finishes. */

import { z } from "zod";

import { createResource } from "../../../agent-exec/resource-provider.ts";
import type { Context } from "../../../context/context.ts";

const APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const APPROVAL_STORE_MISSING = "Auto-review MCP approval store is not configured";

export interface SmartModeMcpApprovalRequestRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly createdAtMs: number;
  readonly fingerprint: string;
  readonly blockReason: string;
}

export interface SmartModeMcpApprovalStore {
  createPendingRequest(ctx: Context, request: SmartModeMcpApprovalRequestRecord): Promise<void>;
  deletePendingRequest(ctx: Context, requestId: string): Promise<void>;
}

export const smartModeMcpApprovalRequestRecordSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  createdAtMs: z.number(),
  fingerprint: z.string(),
  blockReason: z.string(),
});

export const smartModeMcpApprovalTtlMs = APPROVAL_LIFETIME_MS;

function requireConfiguredApprovalStore(): never {
  throw new Error(APPROVAL_STORE_MISSING);
}

export const smartModeMcpApprovalStoreResource = createResource<SmartModeMcpApprovalStore>(
  requireConfiguredApprovalStore,
  () => undefined,
);
