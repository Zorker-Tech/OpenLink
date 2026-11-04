import type { BlobStore } from "../../agent-kv/blob-store.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"

export interface RedactedPromptContextUsageTree {
  readonly _privacyMode: PrivacyMode
  readonly schemaVersion: number
  readonly nodes: readonly unknown[]
}

export interface PersistPromptContextUsageSnapshotOptions<Context> {
  readonly blobStore: BlobStore<Context>
  readonly ctx: Context
  readonly privacyMode: PrivacyMode
  readonly rootPromptMessagesJson: readonly Uint8Array[]
  readonly usageTree: RedactedPromptContextUsageTree | undefined
}

export interface SerializedUsageSnapshotCacheValue {
  readonly rootPromptBlobIdsKey: string
  readonly blobId: Uint8Array
}
