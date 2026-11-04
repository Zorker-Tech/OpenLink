import { toHex } from "../../agent-kv/serde.ts"
import type { RedactedPromptContextUsageTree, SerializedUsageSnapshotCacheValue } from "./usage-snapshot-contracts.ts"

const snapshotsByTree = new WeakMap<object, SerializedUsageSnapshotCacheValue>()

export function rootPromptBlobIdsKey(blobIds: readonly Uint8Array[]): string {
  return blobIds.map(toHex).join(",")
}

export function cachedUsageSnapshot(
  tree: RedactedPromptContextUsageTree,
  rootBlobIdsKey: string,
): Uint8Array | undefined {
  const cached = snapshotsByTree.get(tree)
  return cached?.rootPromptBlobIdsKey === rootBlobIdsKey ? cached.blobId : undefined
}

export function rememberUsageSnapshot(
  tree: RedactedPromptContextUsageTree,
  value: SerializedUsageSnapshotCacheValue,
): void {
  snapshotsByTree.set(tree, value)
}
