import { randomUUID } from "node:crypto"

import { getConversationId } from "../../utils/request-scope.ts"
import type { Context } from "../../../context/context.ts"
import type { SmartModeMcpApprovalStore } from "./smart-mode-approval-store.ts"
import { fingerprintMcpApprovalTarget } from "./smart-mode-approval-fingerprint.ts"
import type { McpApprovalFingerprintInput } from "./smart-mode-approval-contracts.ts"

export { fingerprintMcpApprovalTarget } from "./smart-mode-approval-fingerprint.ts"
export type { McpApprovalFingerprintInput } from "./smart-mode-approval-contracts.ts"

export const MCP_APPROVAL_MISSING_CONVERSATION_REASON = "Auto-review MCP approvals require a conversation id"

export async function createMcpApprovalRequest(
  context: Context,
  store: SmartModeMcpApprovalStore,
  target: McpApprovalFingerprintInput,
): Promise<{ requestId: string; fingerprint: string; conversationId: string; blockReason: string }> {
  const conversationId = getConversationId(context)
  if (conversationId === undefined) throw new Error(MCP_APPROVAL_MISSING_CONVERSATION_REASON)

  const request = {
    id: randomUUID(),
    conversationId,
    createdAtMs: Date.now(),
    fingerprint: fingerprintMcpApprovalTarget(target),
    blockReason: target.blockReason,
  }
  await store.createPendingRequest(context, request)
  return {
    requestId: request.id,
    fingerprint: request.fingerprint,
    conversationId,
    blockReason: request.blockReason,
  }
}

export async function cancelMcpApprovalRequest(
  context: Context,
  store: SmartModeMcpApprovalStore,
  requestId: string,
): Promise<void> {
  await store.deletePendingRequest(context, requestId)
}
