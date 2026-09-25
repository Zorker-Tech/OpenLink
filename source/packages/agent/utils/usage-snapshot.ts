/**
 * Storing the prompt-context usage tree with the prompt it describes.
 *
 * The tree is how the platform can later answer "what did this turn's context window hold", and the
 * answer is only useful next to the messages it measured — so both go into one snapshot blob. Two
 * things are deliberately skipped: a privacy mode that forbids storage writes nothing at all, and a
 * tree whose messages have not changed since the last write reuses the blob it already has, which is
 * what keeps a long turn from writing the same snapshot on every step.
 */

import type { BlobStore } from "../../agent-kv/blob-store.ts"
import { getBlobId } from "../../agent-kv/blob-store.ts"
import { toHex } from "../../agent-kv/serde.ts"
import { getBlobMetadataCallback, setBlobReadableFromCloudMirror } from "../../agent-kv/typed-blob-store.ts"
import { PrivacyCapability } from "../../redaction/classification.ts"
import { fromRedactedPromptContextUsageTree } from "../../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PromptContextUsageSnapshot } from "../../proto/generated/agent/v1/agent_pb.ts"
import type { PromptContextUsageTree } from "../../proto/generated/agent/v1/agent_pb.ts"
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../../proto/generated/aiserver/v1/privacy_mode_pb.ts"

interface RedactedPromptContextUsageTree {
  readonly _privacyMode: PrivacyModeValue
  readonly schemaVersion: number
  readonly nodes: readonly unknown[]
}

export interface PersistPromptContextUsageSnapshotOptions<Context> {
  readonly blobStore: BlobStore<Context>
  readonly ctx: Context
  readonly privacyMode: PrivacyModeValue
  readonly rootPromptMessagesJson: readonly Uint8Array[]
  readonly usageTree: RedactedPromptContextUsageTree | undefined
}

/** The tree is stored redacted; reading it back is a storage read, which is what the purpose says. */
const fromRedactedUsageTree = fromRedactedPromptContextUsageTree as unknown as (
  message: RedactedPromptContextUsageTree,
  purpose: PrivacyCapability,
) => PromptContextUsageTree

const serializedSnapshots = new WeakMap<object, { rootPromptBlobIdsKey: string; blobId: Uint8Array }>()

function rootPromptBlobIdsKey(blobIds: readonly Uint8Array[]): string {
  return blobIds.map(toHex).join(",")
}

export async function persistPromptContextUsageSnapshot<Context>(
  options: PersistPromptContextUsageSnapshotOptions<Context>,
): Promise<Uint8Array | undefined> {
  if (options.privacyMode === PrivacyMode.NO_STORAGE || options.usageTree === undefined) return undefined

  const rootBlobIdsKey = rootPromptBlobIdsKey(options.rootPromptMessagesJson)
  const cached = serializedSnapshots.get(options.usageTree)
  if (cached?.rootPromptBlobIdsKey === rootBlobIdsKey) return cached.blobId

  const snapshot = new PromptContextUsageSnapshot({
    promptContextUsageTree: fromRedactedUsageTree(options.usageTree, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    rootPromptMessagesJson: [...options.rootPromptMessagesJson],
  })
  const serialized = snapshot.toBinary()
  const blobId = await getBlobId(serialized)
  getBlobMetadataCallback(options.blobStore)?.({
    blobId,
    blobType: { kind: "proto", typeName: "agent.v1.PromptContextUsageSnapshot" },
  })
  await setBlobReadableFromCloudMirror({
    blobStore: options.blobStore,
    ctx: options.ctx,
    blobId,
    blobData: serialized,
  })
  serializedSnapshots.set(options.usageTree, { rootPromptBlobIdsKey: rootBlobIdsKey, blobId })
  return blobId
}
