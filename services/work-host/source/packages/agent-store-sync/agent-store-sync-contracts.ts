/** Slate's agent-store contracts, independent of the remote message encoding. */

export const AGENT_STORE_CONFLICT_HOOK_EVENT_NAME = "agentStoreConflict"

export type AgentStoreSourceKind = "cloud" | "local" | "user" | "team" | "automation"

export type AgentStoreMintTarget =
  | { readonly kind: "share"; readonly shareId: string }
  | { readonly kind: "store"; readonly storeId: string }
  | { readonly kind: "source"; readonly sourceKind: AgentStoreSourceKind; readonly sourceId: string }

export interface AgentStoreToken {
  readonly token: string
  readonly expiresAtMs: number
  readonly storeIds: readonly string[]
}

export interface AgentStoreReadInstruction {
  readonly relPath: string
  readonly url: string
  readonly expiresAtMs: number
}

export interface AgentStoreWriteFile {
  readonly relPath: string
  readonly sha: string
  readonly size: number
  readonly baseEtag?: string
  readonly expectAbsent?: boolean
  readonly multipartParts?: readonly {
    readonly partNumber: number
    readonly offsetBytes: number
    readonly sizeBytes: number
    readonly checksumSha256: Uint8Array
  }[]
}

export interface AgentStoreMultipartContext {
  readonly uploadId: string
  readonly storeId: string
  readonly relPath: string
  readonly sizeBytes: number
  readonly sha: string
  readonly expectedPartCount: number
  readonly precondition: { readonly case: "baseEtag"; readonly value: string } | { readonly case: "expectAbsent"; readonly value: boolean } | { readonly case: undefined }
  readonly sessionId: string
}

export interface AgentStoreMultipartWriteInstruction {
  readonly context: AgentStoreMultipartContext
  readonly parts: readonly {
    readonly partNumber: number
    readonly url: string
    readonly headers: Record<string, string>
    readonly offsetBytes: number
    readonly sizeBytes: number
  }[]
  readonly partUrlsExpiresAtMs: number
}

export interface AgentStoreWriteInstruction {
  readonly relPath: string
  readonly sha: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly expiresAtMs: number
  readonly multipart?: AgentStoreMultipartWriteInstruction
  readonly primaryPreconditionFailed?: boolean
  readonly lockRedirect?: { readonly conflictRelPath: string; readonly lockExpiresAtMs: number }
  readonly conflict?: {
    readonly relPath: string
    readonly url: string
    readonly headers: Record<string, string>
    readonly expiresAtMs: number
    readonly multipart?: AgentStoreMultipartWriteInstruction
  }
}

export interface AgentStoreMultipartWriteCompletion {
  readonly context: AgentStoreMultipartContext
  readonly parts: readonly { readonly partNumber: number; readonly etag: string; readonly checksumSha256: Uint8Array }[]
}

export interface AgentStoreMultipartWriteAbort {
  readonly context: AgentStoreMultipartContext
}

export interface AgentStoreListFile {
  readonly relPath: string
  readonly etag: string
  readonly size: number
  readonly serverMtimeMs: number
}

export interface AgentStoreTombstone {
  readonly relPath: string
  readonly tombstoneEtag: string
  readonly deletedAtMs: number
}

export interface AgentStoreListing {
  readonly files: readonly AgentStoreListFile[]
  readonly subdirs: readonly string[]
  readonly tombstones: readonly AgentStoreTombstone[]
  readonly listingComplete: boolean
  readonly skippedUnsafeEntries?: number
}

export interface AgentStoreRpcCallOptions {
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface AgentStoreDirectoryQuery {
  readonly storeId: string
  readonly shareId?: string
  readonly relativePath: string
  readonly pageSize: number
  readonly pageToken: string
  readonly preferCompleteFlatStore: boolean
}

export type AgentStoreDirectoryPage = {
  readonly kind: "complete"
  readonly files: readonly AgentStoreListFile[]
  readonly tombstones: readonly AgentStoreTombstone[]
} | {
  readonly kind: "page"
  readonly files: readonly AgentStoreListFile[]
  readonly subdirs: readonly string[]
  readonly tombstones: readonly AgentStoreTombstone[]
  readonly nextPageToken: string
}

export interface AgentStoreRemoteMultipartWriteInstruction {
  readonly context?: AgentStoreMultipartContext
  readonly parts: readonly {
    readonly partNumber: number
    readonly url: string
    readonly headers: Readonly<Record<string, string>>
    readonly offsetBytes: number
    readonly sizeBytes: number
  }[]
  readonly partUrlsExpiresAtMs: number
}

export interface AgentStoreRemoteWriteLocation {
  readonly relPath: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAtMs: number
  readonly multipart?: AgentStoreRemoteMultipartWriteInstruction
}

export interface AgentStoreRemoteWriteInstruction extends AgentStoreRemoteWriteLocation {
  readonly primaryPreconditionFailed?: boolean
  readonly lockRedirect?: { readonly conflictRelPath: string; readonly lockExpiresAtMs: number }
  readonly conflict?: AgentStoreRemoteWriteLocation
}

export interface AgentStoreMultipartRpcResult {
  readonly inputIndex: number
  readonly relPath: string
  readonly outcome:
    | { readonly kind: "success"; readonly etag?: string; readonly alreadyFinished?: boolean }
    | { readonly kind: "failure"; readonly code: string }
    | { readonly kind: "unknown" }
}

export interface AgentStoreDeleteFile {
  readonly relPath: string
  readonly baseEtag: string
  readonly mutationId?: string
}

export interface AgentStoreDeleteOutcome {
  readonly relPath: string
  readonly status: string
  readonly tombstoneEtag?: string
  readonly currentEtag?: string
}

/** Slate-facing operations backed by an external agent-store service adapter. */
export interface AgentStoreCloudClient {
  mintToken(target: AgentStoreMintTarget, options?: AgentStoreRpcCallOptions): Promise<AgentStoreToken>
  listDirectory(query: AgentStoreDirectoryQuery, options?: AgentStoreRpcCallOptions): Promise<AgentStoreDirectoryPage>
  presignReads(request: { readonly storeId: string; readonly shareId?: string; readonly relPaths: readonly string[] }, options?: AgentStoreRpcCallOptions): Promise<readonly AgentStoreReadInstruction[]>
  presignWrites(request: { readonly storeId: string; readonly files: readonly AgentStoreWriteFile[] }, options?: AgentStoreRpcCallOptions): Promise<readonly AgentStoreRemoteWriteInstruction[]>
  completeWrites(request: { readonly storeId: string; readonly completions: readonly AgentStoreMultipartWriteCompletion[] }, options?: AgentStoreRpcCallOptions): Promise<readonly AgentStoreMultipartRpcResult[]>
  abortWrites(request: { readonly storeId: string; readonly uploads: readonly AgentStoreMultipartWriteAbort[] }, options?: AgentStoreRpcCallOptions): Promise<readonly AgentStoreMultipartRpcResult[]>
  deleteFiles(request: { readonly storeId: string; readonly files: readonly AgentStoreDeleteFile[] }, options?: AgentStoreRpcCallOptions): Promise<readonly AgentStoreDeleteOutcome[]>
}

export interface AgentStoreListRequest {
  readonly token: AgentStoreToken
  readonly storeId: string
  readonly relPath: string
  readonly shareId?: string | undefined
  readonly signal?: AbortSignal | undefined
}

export interface AgentStoreReadRequest {
  readonly token: AgentStoreToken
  readonly storeId: string
  readonly relPaths: readonly string[]
  readonly shareId?: string | undefined
  readonly signal?: AbortSignal | undefined
}

export interface AgentStoreWriteRequest {
  readonly token: AgentStoreToken
  readonly storeId: string
  readonly files: readonly AgentStoreWriteFile[]
  readonly signal?: AbortSignal | undefined
}

export interface AgentStoreDeleteRequest {
  readonly token: AgentStoreToken
  readonly storeId: string
  readonly files: readonly { readonly relPath: string; readonly baseEtag: string; readonly mutationId?: string }[]
  readonly signal?: AbortSignal | undefined
}

export interface AgentStoreMultipartCompletionRequest {
  readonly token: AgentStoreToken
  readonly storeId: string
  readonly completions: readonly AgentStoreMultipartWriteCompletion[]
  readonly signal?: AbortSignal | undefined
}

export interface AgentStoreMultipartAbortRequest {
  readonly token: AgentStoreToken
  readonly storeId: string
  readonly uploads: readonly AgentStoreMultipartWriteAbort[]
  readonly signal?: AbortSignal | undefined
}

/** The typed operations the token client adds authorization to. */
export interface AgentStoreOperationsPort {
  mintToken(target: AgentStoreMintTarget): Promise<AgentStoreToken>
  listFiles(request: AgentStoreListRequest): Promise<unknown>
  presignReads(request: AgentStoreReadRequest): Promise<unknown>
  presignWrites(request: AgentStoreWriteRequest): Promise<unknown>
  deleteFiles?(request: AgentStoreDeleteRequest): Promise<unknown>
  completeMultipartWrites?(request: AgentStoreMultipartCompletionRequest): Promise<unknown>
  abortMultipartWrites?(request: AgentStoreMultipartAbortRequest): Promise<unknown>
  invalidateListCache?(target: { readonly storeId: string; readonly shareId?: string }): void
}
