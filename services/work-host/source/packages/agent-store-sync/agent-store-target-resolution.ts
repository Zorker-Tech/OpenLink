import {
  isAgentStoreId,
  isCloudAgentStoreId,
  isValidBareUuid,
  parseTeamAgentStoreSourceId,
  parseUserAgentStoreSourceId,
} from "./identifiers.ts"
import { AgentStoreUnauthorizedError } from "./bcs-client.ts"
import type { AgentStoreMintTarget, AgentStoreSourceKind } from "./agent-store-sync-contracts.ts"

export interface AgentStoreTargetRequest {
  readonly agentId: string
  readonly shareId?: string | undefined
  readonly sourceKind?: AgentStoreSourceKind | undefined
}

/** Resolves the id the host supplied into the kind of store authorization it names. */
export function resolveAgentStoreMintTarget(request: AgentStoreTargetRequest): AgentStoreMintTarget {
  if (request.shareId !== undefined) return { kind: "share", shareId: request.shareId }
  if (request.sourceKind !== undefined) {
    return { kind: "source", sourceKind: request.sourceKind, sourceId: request.agentId }
  }
  if (isAgentStoreId(request.agentId)) return { kind: "store", storeId: request.agentId }
  if (isCloudAgentStoreId(request.agentId)) return { kind: "source", sourceKind: "cloud", sourceId: request.agentId }
  if (isValidBareUuid(request.agentId)) return { kind: "source", sourceKind: "local", sourceId: request.agentId }
  if (parseUserAgentStoreSourceId(request.agentId) !== undefined) {
    return { kind: "source", sourceKind: "user", sourceId: request.agentId }
  }
  if (parseTeamAgentStoreSourceId(request.agentId) !== undefined) {
    return { kind: "source", sourceKind: "team", sourceId: request.agentId }
  }
  throw new AgentStoreUnauthorizedError("Agent store target is not a valid store or source id")
}
