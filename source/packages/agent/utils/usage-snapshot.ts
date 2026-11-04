import { getBlobId } from "../../agent-kv/blob-store.ts"
import { metadataObserverForStore, ensureBlobVisibleToCloudMirror } from "../../agent-kv/typed-blob-store.ts"
import {
  isUsageSnapshotStorageAllowed,
  PROMPT_CONTEXT_USAGE_SNAPSHOT_TYPE_NAME,
  serializePromptContextUsageSnapshot,
} from "../../../adapters/interop/agent/prompt-context-usage-snapshot-adapter.ts"
import {
  cachedUsageSnapshot,
  rememberUsageSnapshot,
  rootPromptBlobIdsKey,
} from "./usage-snapshot-cache.ts"
import type { PersistPromptContextUsageSnapshotOptions } from "./usage-snapshot-contracts.ts"

export type { PersistPromptContextUsageSnapshotOptions } from "./usage-snapshot-contracts.ts"

export async function persistPromptContextUsageSnapshot<Context>(
  options: PersistPromptContextUsageSnapshotOptions<Context>,
): Promise<Uint8Array | undefined> {
  if (!isUsageSnapshotStorageAllowed(options.privacyMode) || options.usageTree === undefined) return undefined

  const rootBlobIdsKey = rootPromptBlobIdsKey(options.rootPromptMessagesJson)
  const cached = cachedUsageSnapshot(options.usageTree, rootBlobIdsKey)
  if (cached !== undefined) return cached

  const serialized = serializePromptContextUsageSnapshot(
    options.usageTree,
    options.rootPromptMessagesJson,
  )
  const blobId = await getBlobId(serialized)
  metadataObserverForStore(options.blobStore)?.({
    blobId,
    blobType: { kind: "proto", typeName: PROMPT_CONTEXT_USAGE_SNAPSHOT_TYPE_NAME },
  })
  await ensureBlobVisibleToCloudMirror({
    blobStore: options.blobStore,
    ctx: options.ctx,
    blobId,
    blobData: serialized,
  })
  rememberUsageSnapshot(options.usageTree, { rootPromptBlobIdsKey: rootBlobIdsKey, blobId })
  return blobId
}
