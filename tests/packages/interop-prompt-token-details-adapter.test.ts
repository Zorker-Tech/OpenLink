import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PromptContextNode,
  PromptContextSourceRef,
  PromptContextUsageTree,
  PromptTokenBreakdownCategory,
  PromptTokenBreakdownSnapshot,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import {
  promptContextUsageTreeToProto,
  promptTokenBreakdownFromProto,
  promptTokenBreakdownToProto,
  redactedPromptTokenDetailsCodec,
} from "../../source/adapters/interop/agent/redacted-prompt-token-details-adapter.ts";
import {
  decodeInteropPromptTokenBreakdown,
  encodeInteropPromptTokenBreakdown,
} from "../../source/adapters/interop/agent/summarize-action-adapter.ts";
import type {
  PromptContextUsageTreeValue,
  PromptTokenBreakdownSnapshotValue,
} from "../../source/packages/agent/utils/prompt-usage-contracts.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";

describe("prompt usage wire adapter", () => {
  it("projects the Slate breakdown to and from the generated message", () => {
    const value: PromptTokenBreakdownSnapshotValue = {
      totalUsedTokens: 12,
      maxTokens: 256,
      categories: [
        { id: "conversation", label: "Conversation", estimatedTokens: 10, characterCount: 40 },
        { id: "tools", label: "Tool definitions", estimatedTokens: 2 },
      ],
    };

    const wire = promptTokenBreakdownToProto(value);
    assert.equal(wire instanceof PromptTokenBreakdownSnapshot, true);
    assert.equal(wire.categories[0] instanceof PromptTokenBreakdownCategory, true);
    assert.deepEqual(promptTokenBreakdownFromProto(wire), value);
    assert.deepEqual(redactedPromptTokenDetailsCodec.decodeBreakdown(
      redactedPromptTokenDetailsCodec.encodeBreakdown(value, PrivacyMode.NO_STORAGE),
    ), value);
    assert.deepEqual(
      decodeInteropPromptTokenBreakdown(encodeInteropPromptTokenBreakdown(value, PrivacyMode.NO_STORAGE)),
      value,
    );
  });

  it("maps Slate usage-tree values into generated nodes and source references", () => {
    const value: PromptContextUsageTreeValue = {
      schemaVersion: 1,
      nodes: [{
        id: "message:0:root:0",
        parentId: "category:conversation",
        kind: "message",
        label: "User Message",
        categoryId: "conversation",
        estimatedTokens: 3,
        characterCount: 12,
        contentAvailable: true,
        source: { sourceType: "root_prompt_message", messageIndex: 0, contentPath: "root:0", startOffset: 0, endOffset: 12 },
      }],
    };

    const wire = promptContextUsageTreeToProto(value);
    assert.equal(wire instanceof PromptContextUsageTree, true);
    assert.equal(wire.nodes[0] instanceof PromptContextNode, true);
    assert.equal(wire.nodes[0]?.source instanceof PromptContextSourceRef, true);
    assert.deepEqual([
      wire.schemaVersion,
      wire.nodes[0]?.id,
      wire.nodes[0]?.parentId,
      wire.nodes[0]?.source?.startOffset,
      wire.nodes[0]?.source?.endOffset,
    ], [1, "message:0:root:0", "category:conversation", 0, 12]);

    const redacted = redactedPromptTokenDetailsCodec.encodeUsageTree(value, PrivacyMode.NO_STORAGE);
    assert.equal(redacted._privacyMode, PrivacyMode.NO_STORAGE);
    assert.equal(redacted.nodes[0]?.id, "message:0:root:0");
  });
});
