import assert from "node:assert/strict"
import { test } from "node:test"

import {
  InteractionUpdate,
  TextDeltaUpdate,
  ToolCall,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { createTaskToolCallDeltaInterop } from "../../source/adapters/interop/agent/task-tool-protocol-adapter.ts"

test("task progress updates retain the complete interaction message at the runner boundary", () => {
  const interaction = new InteractionUpdate({
    message: { case: "textDelta", value: new TextDeltaUpdate({ text: "child progress" }) },
  })
  const delta = createTaskToolCallDeltaInterop(interaction)
  if (delta.delta.case !== "taskToolCallDelta") assert.fail("expected the task progress envelope")
  assert.equal(delta.delta.value.interactionUpdate?.message.case, "textDelta")
  assert.equal(delta.delta.value.interactionUpdate?.message.value.text, "child progress")
})

test("unknown interaction fields survive task progress wrapping", () => {
  const interaction = new InteractionUpdate()
  InteractionUpdate.runtime.bin.onUnknownField(interaction, 731, 0, new Uint8Array([8, 1]))
  const delta = createTaskToolCallDeltaInterop(interaction)
  if (delta.delta.case !== "taskToolCallDelta" || delta.delta.value.interactionUpdate === undefined) {
    assert.fail("expected the unknown interaction message to be carried")
  }
  assert.deepEqual(
    InteractionUpdate.runtime.bin.listUnknownFields(delta.delta.value.interactionUpdate),
    InteractionUpdate.runtime.bin.listUnknownFields(interaction),
  )
})

test("task progress rejects non-interaction messages before producing a tool delta", () => {
  assert.throws(() => createTaskToolCallDeltaInterop({ message: { case: "textDelta", value: { text: "wrong" } } }), /Task progress update is invalid/)
  assert.throws(() => createTaskToolCallDeltaInterop(new ToolCall()), /Task progress update is invalid/)
})
