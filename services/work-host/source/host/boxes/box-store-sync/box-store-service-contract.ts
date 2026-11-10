/** Slate's object-store port for the service that signs box-store transfers. */

export interface MultipartPartPlan {
  readonly partNumber: number
  readonly offset: number
  readonly length: number
  readonly digest: string
}

export interface BoxStoreWritePlan {
  readonly key: string
  readonly digest: string
  readonly size: bigint
  readonly contentAddressed: boolean
  readonly expectedEtag: string
  readonly requireAbsent: boolean
  readonly multipartParts?: readonly { readonly partNumber: number; readonly size: bigint; readonly digest: string }[]
}

export interface BoxStoreMultipartUpload {
  readonly uploadContext: unknown | null
  readonly parts: readonly {
    readonly partNumber: number
    readonly offset: bigint
    readonly length: bigint
    readonly url: string
    readonly headers: Readonly<Record<string, string>>
  }[]
}

export interface BoxStoreWriteInstruction {
  readonly key: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly multipart?: BoxStoreMultipartUpload
}

export type BoxStoreMultipartCompletion =
  | { readonly kind: "success" }
  | { readonly kind: "already-present" }
  | { readonly kind: "retryable-failure"; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "missing" }

export interface BoxStoreServicePort {
  presignReads(keys: readonly string[]): Promise<readonly { readonly key: string; readonly url: string; readonly expiresAtMs: number }[]>
  statObject(key: string): Promise<{ readonly exists: boolean; readonly etag: string }>
  presignWrites(plans: readonly BoxStoreWritePlan[]): Promise<readonly BoxStoreWriteInstruction[]>
  completeMultipartUpload(input: {
    readonly uploadContext: unknown
    readonly parts: readonly { readonly partNumber: number; readonly etag: string }[]
  }): Promise<BoxStoreMultipartCompletion>
  abortMultipartUpload(uploadContext: unknown): Promise<void>
  listPage(input: { readonly prefix: string; readonly cursor: string; readonly pageSize: number }): Promise<{
    readonly keys: readonly string[]
    readonly hasMore: boolean
    readonly nextCursor: string
  }>
}
