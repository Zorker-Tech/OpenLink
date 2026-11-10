export interface SignedObjectRead {
  readonly relPath: string
  readonly url: string
}

export interface StoreProbeResponse {
  readonly status: number
  readonly headers: { readonly get: (name: string) => string | null | undefined }
  readonly body?: { readonly cancel?: () => Promise<unknown> | unknown } | null
}

export interface AgentStoreReadClient {
  presignReads(args: {
    readonly agentId: string
    readonly relPaths: readonly string[]
    readonly signal?: AbortSignal | undefined
  }): Promise<readonly SignedObjectRead[]>
}

export interface StoreProbeFetchOptions {
  readonly redirect: "error"
  readonly signal?: AbortSignal
  readonly headers?: { readonly Range: "bytes=0-0" }
}

export type AsyncOperationRunner = <Result>(operation: () => Promise<Result>) => Promise<Result>

export interface AgentStoreObjectProbeOptions {
  readonly client: AgentStoreReadClient
  readonly agentId: string
  readonly relPath: string
  readonly fetchImpl: (url: string, options: StoreProbeFetchOptions) => Promise<StoreProbeResponse>
  readonly validatePresignedUrl: (url: URL) => void
  readonly signal?: AbortSignal
  readonly runPresign?: AsyncOperationRunner
  readonly runS3?: AsyncOperationRunner
}

export type AgentStoreObjectProbeResult =
  | { readonly kind: "absent" }
  | { readonly kind: "exists"; readonly etag: string }
