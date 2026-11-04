import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createSlateConversationPlanSerde,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { ConversationPlan } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { slateConversationPlanFromValue } from "../../source/packages/agent/conversation-plan-state.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

test("plan input becomes Slate text while historical privacy wrappers stay at the edge", () => {
  assert.deepEqual(slateConversationPlanFromValue("# Plan"), { content: "# Plan" })
  assert.deepEqual(
    slateConversationPlanFromValue({
      plan: createRedactedString(
        "# Private plan",
        DataClassification.CODE,
        "plan",
        PrivacyMode.NO_STORAGE,
      ),
    }),
    { content: "# Private plan" },
  )
})

test("a plan without text is refused instead of being stored as an empty plan", () => {
  assert.throws(() => slateConversationPlanFromValue(undefined), TypeError)
  assert.throws(() => slateConversationPlanFromValue({ steps: [] }), TypeError)
  assert.throws(() => slateConversationPlanFromValue({ plan: 42 }), TypeError)
})

test("Slate plan state writes an owned envelope and imports legacy ConversationPlan blobs", () => {
  const serde = createSlateConversationPlanSerde(PrivacyMode.NO_STORAGE)
  const content = "# Plan\n\n1. Preserve every observable behavior."
  const bytes = serde.serialize({ content })

  assert.ok(new TextDecoder().decode(bytes).startsWith("SLATE-AGENT-PLAN\n"))
  assert.equal(JSON.parse(new TextDecoder().decode(bytes).slice("SLATE-AGENT-PLAN\n".length)).plan.content, content)
  assert.deepEqual(serde.deserialize(bytes), { content })
  assert.deepEqual(
    serde.deserialize(new ConversationPlan({ plan: "previous checkpoint" }).toBinary()),
    { content: "previous checkpoint" },
  )
  assert.deepEqual(serde.getBlobType?.(), { kind: "json", typeName: "slate.agent-conversation-plan" })
})

test("unknown legacy plan fields survive the Slate format migration", () => {
  const serde = createSlateConversationPlanSerde(PrivacyMode.NO_STORAGE)
  const legacy = new ConversationPlan({ plan: "previous checkpoint" })
  ConversationPlan.runtime.bin.onUnknownField(legacy, 100, 0, new Uint8Array([9]))

  const imported = serde.deserialize(legacy.toBinary())
  assert.equal(imported.compatibility?.legacyUnknownFields?.length, 1)
  const rewritten = serde.serialize(imported)
  assert.ok(new TextDecoder().decode(rewritten).startsWith("SLATE-AGENT-PLAN\n"))
  assert.equal(serde.deserialize(rewritten).compatibility?.legacyUnknownFields?.length, 1)
})
