import { toHex } from "../../agent-kv/serde.ts"
import type { PromptContextUsageTreeValue } from "./prompt-usage-contracts.ts"
import type { SerializedUsageSnapshotCacheValue } from "./usage-snapshot-contracts.ts"

const snapshotsByTree = new WeakMap<object, SerializedUsageSnapshotCacheValue>()

export function rootPromptBlobIdsKey(blobIds: readonly Uint8Array[]): string {
  return blobIds.map(toHex).join(",")
}

export function cachedUsageSnapshot(
  tree: PromptContextUsageTreeValue,
  rootBlobIdsKey: string,
): Uint8Array | undefined {
  const cached = snapshotsByTree.get(tree)
  return cached?.rootPromptBlobIdsKey === rootBlobIdsKey ? cached.blobId : undefined
}

export function rememberUsageSnapshot(
  tree: PromptContextUsageTreeValue,
  value: SerializedUsageSnapshotCacheValue,
): void {
  snapshotsByTree.set(tree, value)
}
