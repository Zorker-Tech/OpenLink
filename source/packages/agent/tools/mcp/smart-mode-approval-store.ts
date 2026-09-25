/**
 * Where a pending smart-mode approval for an MCP call is recorded.
 *
 * A blocked MCP call is shown to the user as an approval request, and the request has to outlive the turn
 * that raised it: the user may answer minutes later, in another window, or not at all. So it is written
 * to a store that belongs to the environment rather than to the turn, and removed when it is answered —
 * which is what makes "still pending" a fact rather than a guess.
 *
 * The store is a resource, so the implementation is provided by whoever runs the agent: a session with no
 * approval flow configured fails loudly rather than pretending an approval was recorded.
 */

import { createResource } from "../../../agent-exec/resource-provider.ts"
import type { Context } from "../../../context/context.ts"
import { z } from "zod"

const SMART_MODE_MCP_APPROVAL_TTL_SECONDS = 24 * 60 * 60
const SMART_MODE_MCP_APPROVAL_TTL_MS = SMART_MODE_MCP_APPROVAL_TTL_SECONDS * 1_000

export interface SmartModeMcpApprovalRequestRecord {
  readonly id: string
  readonly conversationId: string
  readonly createdAtMs: number
  readonly fingerprint: string
  readonly blockReason: string
}

export interface SmartModeMcpApprovalStore {
  createPendingRequest(ctx: Context, request: SmartModeMcpApprovalRequestRecord): Promise<void>
  deletePendingRequest(ctx: Context, requestId: string): Promise<void>
}

/** The record as it is stored, so a store can validate what it reads back. */
export const smartModeMcpApprovalRequestRecordSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  createdAtMs: z.number(),
  fingerprint: z.string(),
  blockReason: z.string(),
})

/** How long a pending approval stays answerable before it is stale. */
export const smartModeMcpApprovalTtlMs = SMART_MODE_MCP_APPROVAL_TTL_MS

export const smartModeMcpApprovalStoreResource = createResource<SmartModeMcpApprovalStore>(
  () => {
    throw new Error("Auto-review MCP approval store is not configured")
  },
  () => {},
)
