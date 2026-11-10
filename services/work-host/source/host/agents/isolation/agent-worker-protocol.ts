/** Slate's private typed protocol between the host thread and its agent-store worker. */
export interface AgentStoreWorkerBoot {
  readonly agentId: string;
  readonly blobDbPath: string;
  readonly busyTimeoutMs?: number;
  readonly legacyBlobDbPath?: string;
}

interface WorkerCommandBase {
  readonly callId: number;
}

export type AgentStoreWorkerCommand = WorkerCommandBase & (
  | { readonly operation: "worker.identify" }
  | { readonly operation: "blob.write"; readonly blobId: Uint8Array; readonly blobBytes: Uint8Array }
  | { readonly operation: "blob.read"; readonly blobId: Uint8Array }
  | { readonly operation: "root.find-latest" }
  | { readonly operation: "blob.clear" }
  | { readonly operation: "checkpoint.prune"; readonly retainedRootIdHex: string }
  | { readonly operation: "conversation.collect-garbage"; readonly retainedRootIdHex: string; readonly pendingWriteRetentionMs: number }
  | { readonly operation: "legacy.verify-retirement"; readonly retainedRootIdHex: string; readonly legacyBlobDbPath: string }
  | { readonly operation: "store.flush" }
  | { readonly operation: "worker.close" }
)

export type AgentStoreWorkerSuccess = WorkerCommandBase & (
  | { readonly outcome: "success"; readonly operation: "worker.identify"; readonly workerThreadId: number; readonly processId: number }
  | { readonly outcome: "success"; readonly operation: "blob.write" }
  | { readonly outcome: "success"; readonly operation: "blob.read"; readonly blobBytes?: Uint8Array | undefined }
  | { readonly outcome: "success"; readonly operation: "root.find-latest"; readonly latestRootId?: Uint8Array | undefined }
  | { readonly outcome: "success"; readonly operation: "blob.clear" }
  | { readonly outcome: "success"; readonly operation: "checkpoint.prune"; readonly deletedCount: number }
  | { readonly outcome: "success"; readonly operation: "conversation.collect-garbage"; readonly garbageReport: unknown }
  | { readonly outcome: "success"; readonly operation: "legacy.verify-retirement"; readonly retirementVerdict: unknown }
  | { readonly outcome: "success"; readonly operation: "store.flush" }
  | { readonly outcome: "success"; readonly operation: "worker.close" }
)

export interface AgentStoreWorkerFailure extends WorkerCommandBase {
  readonly outcome: "failure";
  readonly message: string;
  readonly name?: string;
  readonly code?: string;
}

export type AgentStoreWorkerReply = AgentStoreWorkerSuccess | AgentStoreWorkerFailure
export type AgentStoreWorkerOperation = AgentStoreWorkerCommand["operation"]
export type AgentStoreWorkerCommandFor<Operation extends AgentStoreWorkerOperation> = Extract<AgentStoreWorkerCommand, { readonly operation: Operation }>
export type AgentStoreWorkerSuccessFor<Operation extends AgentStoreWorkerOperation> = Extract<AgentStoreWorkerSuccess, { readonly operation: Operation }>

const WORKER_OPERATIONS = new Set<AgentStoreWorkerOperation>([
  "worker.identify",
  "blob.write",
  "blob.read",
  "root.find-latest",
  "blob.clear",
  "checkpoint.prune",
  "conversation.collect-garbage",
  "legacy.verify-retirement",
  "store.flush",
  "worker.close",
])

export function isAgentStoreWorkerOperation(value: unknown): value is AgentStoreWorkerOperation {
  return typeof value === "string" && WORKER_OPERATIONS.has(value as AgentStoreWorkerOperation)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCallId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isText(value: unknown): value is string {
  return typeof value === "string"
}

function isOptionalBytes(value: unknown): boolean {
  return value === undefined || value instanceof Uint8Array
}

export function parseAgentStoreWorkerBoot(value: unknown): AgentStoreWorkerBoot | null {
  if (!isRecord(value)) return null
  if (!isText(value.agentId) || value.agentId.length === 0) return null
  if (!isText(value.blobDbPath) || value.blobDbPath.length === 0) return null
  if (value.busyTimeoutMs !== undefined && (!isFiniteNumber(value.busyTimeoutMs) || value.busyTimeoutMs < 0)) return null
  if (value.legacyBlobDbPath !== undefined && !isText(value.legacyBlobDbPath)) return null
  return value as unknown as AgentStoreWorkerBoot
}

export function parseAgentStoreWorkerCommand(value: unknown): AgentStoreWorkerCommand | null {
  if (!isRecord(value) || !isCallId(value.callId)) return null
  switch (value.operation) {
    case "worker.identify":
    case "root.find-latest":
    case "blob.clear":
    case "store.flush":
    case "worker.close":
      return value as unknown as AgentStoreWorkerCommand
    case "blob.write":
      return value.blobId instanceof Uint8Array && value.blobBytes instanceof Uint8Array
        ? value as unknown as AgentStoreWorkerCommand
        : null
    case "blob.read":
      return value.blobId instanceof Uint8Array
        ? value as unknown as AgentStoreWorkerCommand
        : null
    case "checkpoint.prune":
      return isText(value.retainedRootIdHex) ? value as unknown as AgentStoreWorkerCommand : null
    case "conversation.collect-garbage":
      return isText(value.retainedRootIdHex) && isFiniteNumber(value.pendingWriteRetentionMs)
        ? value as unknown as AgentStoreWorkerCommand
        : null
    case "legacy.verify-retirement":
      return isText(value.retainedRootIdHex) && isText(value.legacyBlobDbPath)
        ? value as unknown as AgentStoreWorkerCommand
        : null
    default:
      return null
  }
}

export function parseAgentStoreWorkerReply(value: unknown): AgentStoreWorkerReply | null {
  if (!isRecord(value) || !isCallId(value.callId)) return null
  if (value.outcome === "failure") {
    if (!isText(value.message)) return null
    if (value.name !== undefined && !isText(value.name)) return null
    if (value.code !== undefined && !isText(value.code)) return null
    return value as unknown as AgentStoreWorkerFailure
  }
  if (value.outcome !== "success" || !isText(value.operation)) return null
  switch (value.operation) {
    case "worker.identify":
      return Number.isSafeInteger(value.workerThreadId) && (value.workerThreadId as number) > 0 &&
        Number.isSafeInteger(value.processId) && (value.processId as number) > 0
        ? value as unknown as AgentStoreWorkerSuccess
        : null
    case "blob.write":
    case "blob.clear":
    case "store.flush":
    case "worker.close":
      return value as unknown as AgentStoreWorkerSuccess
    case "blob.read":
      return isOptionalBytes(value.blobBytes) ? value as unknown as AgentStoreWorkerSuccess : null
    case "root.find-latest":
      return isOptionalBytes(value.latestRootId) ? value as unknown as AgentStoreWorkerSuccess : null
    case "checkpoint.prune":
      return Number.isSafeInteger(value.deletedCount) && (value.deletedCount as number) >= 0
        ? value as unknown as AgentStoreWorkerSuccess
        : null
    case "conversation.collect-garbage":
      return "garbageReport" in value ? value as unknown as AgentStoreWorkerSuccess : null
    case "legacy.verify-retirement":
      return "retirementVerdict" in value ? value as unknown as AgentStoreWorkerSuccess : null
    default:
      return null
  }
}
