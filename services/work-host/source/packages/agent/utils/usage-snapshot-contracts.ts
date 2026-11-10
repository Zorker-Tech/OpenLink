import type { BlobStore } from "../../agent-kv/blob-store.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import type { PromptContextUsageTreeValue } from "./prompt-usage-contracts.ts"

export interface PersistPromptContextUsageSnapshotOptions<Context> {
  readonly blobStore: BlobStore<Context>
  readonly ctx: Context
  readonly privacyMode: PrivacyMode
  readonly rootPromptMessagesJson: readonly Uint8Array[]
  readonly usageTree: PromptContextUsageTreeValue | undefined
}

export interface SerializedUsageSnapshotCacheValue {
  readonly rootPromptBlobIdsKey: string
  readonly blobId: Uint8Array
}
