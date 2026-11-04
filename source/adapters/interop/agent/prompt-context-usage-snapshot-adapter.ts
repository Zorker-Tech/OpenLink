import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import {
  fromRedactedPromptContextUsageTree,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import {
  PromptContextUsageSnapshot,
  type PromptContextUsageTree,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../../../packages/redaction/privacy-mode.ts"
import type { RedactedPromptContextUsageTree } from "../../../packages/agent/utils/usage-snapshot-contracts.ts"

const decodeUsageTree = fromRedactedPromptContextUsageTree as unknown as (
  value: RedactedPromptContextUsageTree,
  capability: PrivacyCapability,
) => PromptContextUsageTree

export const PROMPT_CONTEXT_USAGE_SNAPSHOT_TYPE_NAME = PromptContextUsageSnapshot.typeName

export function isUsageSnapshotStorageAllowed(privacyMode: PrivacyModeValue): boolean {
  return privacyMode !== PrivacyMode.NO_STORAGE
}

export function serializePromptContextUsageSnapshot(
  usageTree: RedactedPromptContextUsageTree,
  rootPromptMessagesJson: readonly Uint8Array[],
): Uint8Array {
  const snapshot = new PromptContextUsageSnapshot({
    promptContextUsageTree: decodeUsageTree(usageTree, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
    rootPromptMessagesJson: [...rootPromptMessagesJson],
  })
  return snapshot.toBinary()
}
