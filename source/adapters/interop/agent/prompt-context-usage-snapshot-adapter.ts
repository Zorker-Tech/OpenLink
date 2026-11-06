import { PromptContextUsageSnapshot } from "../proto/generated/agent/v1/agent_pb.ts"
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../../../packages/redaction/privacy-mode.ts"
import type { PromptContextUsageTreeValue } from "../../../packages/agent/utils/prompt-usage-contracts.ts"
import { promptContextUsageTreeToProto } from "./redacted-prompt-token-details-adapter.ts"

export const PROMPT_CONTEXT_USAGE_SNAPSHOT_TYPE_NAME = PromptContextUsageSnapshot.typeName

export function isUsageSnapshotStorageAllowed(privacyMode: PrivacyModeValue): boolean {
  return privacyMode !== PrivacyMode.NO_STORAGE
}

export function serializePromptContextUsageSnapshot(
  usageTree: PromptContextUsageTreeValue,
  rootPromptMessagesJson: readonly Uint8Array[],
): Uint8Array {
  const snapshot = new PromptContextUsageSnapshot({
    promptContextUsageTree: promptContextUsageTreeToProto(usageTree),
    rootPromptMessagesJson: [...rootPromptMessagesJson],
  })
  return snapshot.toBinary()
}
