import { createHash } from "node:crypto"

import type { McpApprovalFingerprintInput } from "./smart-mode-approval-contracts.ts"

function canonicalApprovalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalApprovalValue)
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => [name, canonicalApprovalValue(item)])
    return Object.fromEntries(fields)
  }
  return value
}

/** Fingerprints only the call identity the user approves, independent of object key order. */
export function fingerprintMcpApprovalTarget(target: McpApprovalFingerprintInput): string {
  const approvalIdentity = {
    serverIdentifier: target.serverIdentifier,
    serverName: target.serverName ?? null,
    serverDisplayName: target.serverDisplayName,
    toolName: target.toolName,
    mcpMode: target.mcpMode,
    mcpArguments: canonicalApprovalValue(target.mcpArguments ?? {}),
    toolDefinitionIdentity: target.toolDefinitionIdentity ?? null,
    toolDefinitionHash: target.toolDefinitionHash ?? null,
  }
  return createHash("sha256").update(JSON.stringify(approvalIdentity)).digest("hex")
}
