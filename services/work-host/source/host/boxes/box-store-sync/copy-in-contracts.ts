import type { BoxStoreDownloadOptions, BoxStoreDownloadSummary } from "./box-store-download.ts"
import type { BoxManifestMap } from "./box-store-manifest.ts"

export interface CopyInResult {
  outcome: "hydrated" | "noop" | "failed"
  message: string
  indexedEntries: number
  storeDatabases: number
  restoredStoreDatabases?: number
  restoredFiles: number
  restoredBytes: number
  verifiedFiles: number
  issues: string[]
  origin?: "legacy"
}

export interface CopyInSync {
  readonly manifestV2Enabled?: boolean | undefined
  readManifestStrict(): Promise<BoxManifestMap>
  readManifestStrictDetailed(): Promise<{ present: boolean; manifest: BoxManifestMap; fullyHydrated?: boolean | undefined }>
  enrollManifestV2?(): void
  download(targetDir: string, options?: BoxStoreDownloadOptions): Promise<BoxStoreDownloadSummary>
  markLegacyHydrationIncomplete?(): Promise<void>
  markLegacyHydrationCompleteForHandoff?(): Promise<void>
}

export interface CopyInFailureResultInput {
  readonly message: string
  readonly indexedEntries: number
  readonly storeDatabases: number
  readonly issues: readonly string[]
  readonly restoredStoreDatabases?: number
  readonly restoredFiles?: number
  readonly restoredBytes?: number
  readonly verifiedFiles?: number
  readonly origin?: "legacy"
}

export function copyInFailureResult(input: CopyInFailureResultInput): CopyInResult {
  return {
    outcome: "failed",
    message: input.message,
    indexedEntries: input.indexedEntries,
    storeDatabases: input.storeDatabases,
    ...(input.restoredStoreDatabases === undefined ? {} : { restoredStoreDatabases: input.restoredStoreDatabases }),
    restoredFiles: input.restoredFiles ?? 0,
    restoredBytes: input.restoredBytes ?? 0,
    verifiedFiles: input.verifiedFiles ?? 0,
    issues: [...input.issues],
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  }
}

export function emptyCopyInResult(reason: string): CopyInResult {
  return { outcome: "noop", message: reason, indexedEntries: 0, storeDatabases: 0, restoredFiles: 0, restoredBytes: 0, verifiedFiles: 0, issues: [] }
}
