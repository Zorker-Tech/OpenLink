/** Convert prompt-analysis details at the redacted Agent state boundary. */

import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import type { PromptTokenDetailsRedactionCodec } from "../../../packages/agent/utils/next-redacted-prompt-context-details.ts"
import type {
  PromptContextUsageTreeValue,
  PromptTokenBreakdownSnapshotValue,
} from "../../../packages/agent/utils/prompt-usage-contracts.ts"
import {
  PromptContextNode,
  PromptContextSourceRef,
  PromptContextUsageTree,
  PromptTokenBreakdownCategory,
  PromptTokenBreakdownSnapshot,
} from "../proto/generated/agent/v1/agent_pb.ts"
import {
  fromRedactedPromptTokenBreakdownSnapshot,
  toRedactedPromptContextUsageTree,
  toRedactedPromptTokenBreakdownSnapshot,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"

type StoredBreakdown = ReturnType<typeof toRedactedPromptTokenBreakdownSnapshot>
type StoredUsageTree = ReturnType<typeof toRedactedPromptContextUsageTree>

export const redactedPromptTokenDetailsCodec: PromptTokenDetailsRedactionCodec<
  PromptTokenBreakdownSnapshotValue,
  PromptContextUsageTreeValue,
  StoredBreakdown,
  StoredUsageTree
> = {
  decodeBreakdown: value => promptTokenBreakdownFromProto(fromRedactedPromptTokenBreakdownSnapshot(
      value,
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
      undefined,
    )),
  encodeBreakdown: (value, privacyMode) => toRedactedPromptTokenBreakdownSnapshot(
    promptTokenBreakdownToProto(value),
    privacyMode,
  ),
  encodeUsageTree: (value, privacyMode) => toRedactedPromptContextUsageTree(
    promptContextUsageTreeToProto(value),
    privacyMode,
  ),
}

export function promptTokenBreakdownToProto(value: PromptTokenBreakdownSnapshotValue): PromptTokenBreakdownSnapshot {
  return new PromptTokenBreakdownSnapshot({
    totalUsedTokens: value.totalUsedTokens,
    maxTokens: value.maxTokens,
    categories: value.categories.map((category) => new PromptTokenBreakdownCategory({
      id: category.id,
      label: category.label,
      estimatedTokens: category.estimatedTokens,
      ...(category.characterCount === undefined ? {} : { characterCount: category.characterCount }),
    })),
  })
}

export function promptTokenBreakdownFromProto(value: PromptTokenBreakdownSnapshot): PromptTokenBreakdownSnapshotValue {
  return {
    totalUsedTokens: value.totalUsedTokens,
    maxTokens: value.maxTokens,
    categories: value.categories.map((category) => ({
      id: category.id,
      label: category.label,
      estimatedTokens: category.estimatedTokens,
      ...(category.characterCount === undefined ? {} : { characterCount: category.characterCount }),
    })),
  }
}

export function promptContextUsageTreeToProto(value: PromptContextUsageTreeValue): PromptContextUsageTree {
  return new PromptContextUsageTree({
    schemaVersion: value.schemaVersion,
    nodes: value.nodes.map((node) => new PromptContextNode({
      id: node.id,
      ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
      kind: node.kind,
      label: node.label,
      categoryId: node.categoryId,
      estimatedTokens: node.estimatedTokens,
      characterCount: node.characterCount,
      contentAvailable: node.contentAvailable,
      ...(node.source === undefined ? {} : { source: new PromptContextSourceRef({ ...node.source }) }),
      ...(node.inlineContent === undefined ? {} : { inlineContent: node.inlineContent }),
    })),
  })
}
