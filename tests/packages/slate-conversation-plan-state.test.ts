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

test("Slate plan state reads and writes the historical ConversationPlan blob", () => {
  const serde = createSlateConversationPlanSerde(PrivacyMode.NO_STORAGE)
  const content = "# Plan\n\n1. Preserve every observable behavior."
  const bytes = serde.serialize({ content })

  assert.equal(ConversationPlan.fromBinary(bytes).plan, content)
  assert.deepEqual(serde.deserialize(bytes), { content })
  assert.deepEqual(
    serde.deserialize(new ConversationPlan({ plan: "previous checkpoint" }).toBinary()),
    { content: "previous checkpoint" },
  )
  assert.deepEqual(serde.getBlobType?.(), {
    kind: "proto",
    typeName: "agent.v1.ConversationPlan",
  })
})
