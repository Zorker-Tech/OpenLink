import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createSlateAssistantMessageStep,
  createSlateThinkingMessageStep,
  createSlateToolCallStep,
} from "../../source/packages/agent/conversation-step-state.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import {
  createSlateConversationStepSerde,
  fromInteropConversationStep,
  fromInteropToolCallStep,
  toInteropConversationStep,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { toRedactedToolCallInterop } from "../../source/adapters/interop/agent/user-message-action-protocol-adapter.ts"
import {
  ConversationStep,
  ToolCall,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"

const text = (value: string) =>
  createRedactedString(value, DataClassification.CODE, "text", PrivacyMode.NO_STORAGE)

test("assistant, thinking and tool steps round-trip through the Slate serde", () => {
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const steps = [
    createSlateAssistantMessageStep(text("answer")),
    createSlateThinkingMessageStep({ text: text("reasoning"), durationMs: 42 }),
    createSlateToolCallStep({
      toolCallId: "call-1",
      startedAtMs: BigInt(10),
      completedAtMs: BigInt(20),
      hookContexts: [{ event: "postToolUse", text: text("notice") }],
      tool: { case: undefined },
    }),
  ] as const

  for (const step of steps) {
    const decoded = serde.deserialize(serde.serialize(step))
    assert.equal(decoded.kind, step.kind)
  }

  const decodedTool = serde.deserialize(serde.serialize(steps[2]))
  assert.equal(decodedTool.kind, "tool-call")
  if (decodedTool.kind === "tool-call") {
    assert.equal(decodedTool.toolCallId, "call-1")
    assert.equal(decodedTool.startedAtMs, BigInt(10))
    assert.equal(decodedTool.completedAtMs, BigInt(20))
    assert.equal(
      decodedTool.hookContexts[0]?.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      "notice",
    )
  }
})

test("the tool-call envelope preserves the oneof case and opaque payload", () => {
  const payload = { args: { message: { case: "text", value: { content: "hello" } } } }
  const step = createSlateToolCallStep({
    toolCallId: "call-1",
    tool: { case: "sendMessageToolCall", value: payload },
  })

  const interop = toInteropConversationStep(step)

  assert.equal(interop.message.case, "toolCall")
  if (interop.message.case === "toolCall") {
    assert.equal(interop.message.value.tool.case, "sendMessageToolCall")
    assert.deepEqual(
      (interop.message.value.tool.value as unknown as { toJson(): unknown }).toJson(),
      {
        args: {
          text: { content: "hello" },
        },
      },
    )
  }
})

test("a persisted tool-call case survives the complete redaction serde", () => {
  const plain = new ToolCall({
    toolCallId: "call-1",
    tool: {
      case: "sendMessageToolCall",
      value: {
        args: { message: { case: "text", value: { content: "hello" } } },
      } as never,
    },
  })
  const step = fromInteropToolCallStep(
    toRedactedToolCallInterop(plain, PrivacyMode.NO_STORAGE),
    "call-1",
  )
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const decoded = serde.deserialize(serde.serialize(step))

  assert.equal(decoded.kind, "tool-call")
  if (decoded.kind === "tool-call") {
    assert.equal(decoded.tool.case, "sendMessageToolCall")
    const content = (decoded.tool.value as {
      args?: {
        message?: {
          value?: {
            content?: { unwrap(purpose: PrivacyCapability): string }
          }
        }
      }
    }).args?.message?.value?.content
    assert.equal(
      content?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      "hello",
    )
  }
})

test("an unknown persisted step case becomes an explicit unsupported step", () => {
  const step = fromInteropConversationStep(new ConversationStep())

  assert.deepEqual(step, { kind: "unsupported" })
  assert.equal(toInteropConversationStep(step).message.case, undefined)
})

test("constructing a tool step copies hook contexts and retains the payload", () => {
  const hookContexts = [{ event: "postToolUse", text: text("notice") }]
  const tool = { case: undefined }
  const step = createSlateToolCallStep({ hookContexts, tool })

  assert.deepEqual(step.hookContexts, hookContexts)
  assert.notEqual(step.hookContexts, hookContexts)
  assert.equal(step.tool, tool)
})
