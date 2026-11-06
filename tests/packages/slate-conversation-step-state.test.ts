import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createSlateAssistantMessageStep,
  createSlateThinkingMessageStep,
  createSlateToolCallStep,
  isSlateConversationSummaryToolCall,
} from "../../source/packages/agent/conversation-step-state.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { isRedactedString } from "../../source/packages/redaction/redacted-values.ts"
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
import {
  AskQuestionArgs,
  AskQuestionArgs_Option,
  AskQuestionArgs_Question,
  AskQuestionAsync,
  AskQuestionError,
  AskQuestionRejected,
  AskQuestionResult,
  AskQuestionSuccess,
  AskQuestionSuccess_Answer,
  AskQuestionToolCall,
} from "../../source/adapters/interop/proto/generated/agent/v1/ask_question_tool_pb.ts"
import {
  CreatePlanArgs,
  CreatePlanError,
  CreatePlanResult,
  CreatePlanSuccess,
  CreatePlanToolCall,
  Phase as CreatePlanPhase,
} from "../../source/adapters/interop/proto/generated/agent/v1/create_plan_tool_pb.ts"
import { TodoItem, TodoStatus } from "../../source/adapters/interop/proto/generated/agent/v1/todo_tool_pb.ts"
import {
  CommunicateUpdateArgs,
  CommunicateUpdateResult,
  CommunicateUpdateSuccess,
  CommunicateUpdateToolCall,
} from "../../source/adapters/interop/proto/generated/agent/v1/communicate_update_tool_pb.ts"
import {
  SendFinalSummaryArgs,
  SendFinalSummaryError,
  SendFinalSummaryResult,
  SendFinalSummarySuccess,
  SendFinalSummaryToolCall,
} from "../../source/adapters/interop/proto/generated/agent/v1/send_final_summary_tool_pb.ts"

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
    const stored = serde.serialize(step)
    assert.ok(new TextDecoder().decode(stored).startsWith("SLATE-AGENT-STEP\n"))
    const decoded = serde.deserialize(stored)
    assert.equal(decoded.kind, step.kind)
  }
  assert.deepEqual(serde.getBlobType?.(), { kind: "json", typeName: "slate.agent-conversation-step" })

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
            content?: {
              unwrap(purpose: PrivacyCapability): string
              readonly __classification?: DataClassification
              readonly __privacyMode?: PrivacyMode
            }
          }
        }
      }
    }).args?.message?.value?.content
    assert.equal(
      content?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      "hello",
    )
    assert.equal(content?.__classification, DataClassification.CODE)
    assert.equal(content?.__privacyMode, PrivacyMode.NO_STORAGE)
  }
})

test("task summary and progress operations use Slate values and rebuild their runner messages", () => {
  const sources = [
    new ConversationStep({
      message: {
        case: "toolCall",
        value: new ToolCall({
          tool: {
            case: "sendFinalSummaryToolCall",
            value: new SendFinalSummaryToolCall({
              args: new SendFinalSummaryArgs({ finalSummary: "final summary" }),
              result: new SendFinalSummaryResult({
                result: { case: "success", value: new SendFinalSummarySuccess({ finalSummary: "delivered" }) },
              }),
            }),
          },
        }),
      },
    }),
    new ConversationStep({
      message: {
        case: "toolCall",
        value: new ToolCall({
          tool: {
            case: "communicateUpdateToolCall",
            value: new CommunicateUpdateToolCall({
              args: new CommunicateUpdateArgs({
                currentStep: "checking files",
                finalSummary: "partial summary",
                completedSubtitle: "reviewing",
              }),
              result: new CommunicateUpdateResult({
                result: {
                  case: "success",
                  value: new CommunicateUpdateSuccess({ currentStep: "checking files", messageIndex: 7 }),
                },
              }),
            }),
          },
        }),
      },
    }),
    new ConversationStep({
      message: {
        case: "toolCall",
        value: new ToolCall({
          tool: {
            case: "sendFinalSummaryToolCall",
            value: new SendFinalSummaryToolCall({
              args: new SendFinalSummaryArgs({ finalSummary: "failed summary" }),
              result: new SendFinalSummaryResult({
                result: { case: "error", value: new SendFinalSummaryError({ error: "summary rejected" }) },
              }),
            }),
          },
        }),
      },
    }),
  ]
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)

  for (const source of sources) {
    const projected = fromInteropConversationStep(source)
    assert.equal(projected.kind, "tool-call")
    if (projected.kind !== "tool-call") assert.fail("expected a tool call")
    assert.equal(projected.tool.kind, "conversation-summary")
    assert.equal(projected.tool.case, undefined)
    const storedText = new TextDecoder().decode(serde.serialize(projected))
    assert.equal(JSON.parse(storedText.slice("SLATE-AGENT-STEP\n".length)).version, 2)
    assert.match(storedText, /"operation":"conversation-summary"/)
    const restored = serde.deserialize(serde.serialize(projected))
    assert.equal(restored.kind, "tool-call")
    if (restored.kind !== "tool-call") assert.fail("expected a stored tool call")
    assert.equal(restored.tool.kind, "conversation-summary")
    assert.deepEqual(toInteropConversationStep(restored).toJson(), source.toJson())
  }
})

test("previous Slate step operation names migrate to the owned summary operation on rewrite", () => {
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const previous = createSlateToolCallStep({
    tool: { case: "sendFinalSummaryToolCall", value: { args: { finalSummary: "saved summary" } } },
  })
  const previousEnvelope = JSON.parse(
    new TextDecoder().decode(serde.serialize(previous)).slice("SLATE-AGENT-STEP\n".length),
  ) as { version: number; step: unknown; compatibility?: unknown }
  previousEnvelope.version = 1
  const previousV1 = new TextEncoder().encode(`SLATE-AGENT-STEP\n${JSON.stringify(previousEnvelope)}`)
  const imported = serde.deserialize(previousV1)
  assert.equal(imported.kind, "tool-call")
  if (imported.kind !== "tool-call") assert.fail("expected a summary tool call")
  assert.equal(imported.tool.kind, "conversation-summary")
  if (imported.tool.kind !== "conversation-summary" || imported.tool.source !== "final") {
    assert.fail("expected the Slate final-summary operation")
  }
  assert.equal(imported.tool.args?.finalSummary, "saved summary")
  const rewritten = new TextDecoder().decode(serde.serialize(imported))
  assert.equal(JSON.parse(rewritten.slice("SLATE-AGENT-STEP\n".length)).version, 2)
  assert.match(rewritten, /"operation":"conversation-summary"/)
  assert.doesNotMatch(rewritten, /sendFinalSummaryToolCall/)
})

test("invalid Slate summary operation data is rejected before it can be stored", () => {
  const invalid = {
    kind: "conversation-summary",
    source: "progress",
    result: { kind: "success", currentStep: "too far", messageIndex: 0x1_0000_0000 },
  }
  assert.equal(isSlateConversationSummaryToolCall(invalid), false)
  const step = createSlateToolCallStep({ tool: invalid as never })
  assert.throws(
    () => createSlateConversationStepSerde(PrivacyMode.NO_STORAGE).serialize(step),
    /Slate conversation summary operation is invalid/,
  )
})

test("plan-draft tool calls use Slate plan, phase, todo, and result values", () => {
  const appendUnknownVarint = (bytes: Uint8Array): Uint8Array => {
    const result = new Uint8Array(bytes.length + 3)
    result.set(bytes)
    result.set([0xa0, 0x06, 0x07], bytes.length)
    return result
  }
  const todos = [
    TodoItem.fromBinary(appendUnknownVarint(new TodoItem({
      id: "todo-1",
      content: "Read files",
      status: TodoStatus.PENDING,
      createdAt: 12n,
      updatedAt: 14n,
    }).toBinary())),
    new TodoItem({ id: "todo-2", content: "Unknown state", status: 99 as TodoStatus, createdAt: 13n, updatedAt: 15n }),
  ]
  const args = new CreatePlanArgs({
    plan: "# Release plan",
    todos,
    overview: "Ship the next release",
    name: "Release",
    isProject: true,
    phases: [new CreatePlanPhase({ name: "Prepare", todos: [todos[0]!] })],
  })
  const sources = [
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "createPlanToolCall", value: new CreatePlanToolCall({
        args,
        result: new CreatePlanResult({ planUri: "slate-plan://release", result: { case: "success", value: new CreatePlanSuccess() } }),
      }) },
    }) } }),
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "createPlanToolCall", value: new CreatePlanToolCall({
        args,
        result: new CreatePlanResult({ planUri: "slate-plan://release", result: { case: "error", value: new CreatePlanError({ error: "could not save" }) } }),
      }) },
    }) } }),
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "createPlanToolCall", value: new CreatePlanToolCall({ args }) },
    }) } }),
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "createPlanToolCall", value: new CreatePlanToolCall({ result: new CreatePlanResult() }) },
    }) } }),
  ]
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)

  for (const source of sources) {
    const projected = fromInteropConversationStep(source)
    assert.equal(projected.kind, "tool-call")
    if (projected.kind !== "tool-call") assert.fail("expected a tool call")
    assert.equal(projected.tool.kind, "plan-draft")
    assert.equal(projected.tool.case, undefined)
    const stored = new TextDecoder().decode(serde.serialize(projected))
    assert.match(stored, /"operation":"plan-draft"/)
    const restored = serde.deserialize(serde.serialize(projected))
    assert.equal(restored.kind, "tool-call")
    if (restored.kind !== "tool-call") assert.fail("expected a stored tool call")
    assert.deepEqual(toInteropConversationStep(restored).toJson(), source.toJson())
  }

  const plan = fromInteropConversationStep(sources[0]!)
  assert.equal(plan.kind, "tool-call")
  if (plan.kind !== "tool-call" || plan.tool.kind !== "plan-draft") assert.fail("expected the Slate plan-draft operation")
  assert.equal(plan.tool.args?.content, "# Release plan")
  assert.equal(plan.tool.args?.isProjectPlan, true)
  assert.equal(plan.tool.args?.phases[0]?.name, "Prepare")
  assert.equal(plan.tool.args?.todos[1]?.status, "unspecified")
  assert.equal(plan.tool.args?.todos[1]?.compatibility?.legacyStatusCode, 99)
  assert.deepEqual(plan.tool.result, { kind: "created", planUri: "slate-plan://release" })
  const roundTrip = toInteropConversationStep(serde.deserialize(serde.serialize(plan)))
  if (roundTrip.message.case !== "toolCall" || roundTrip.message.value.tool.case !== "createPlanToolCall") {
    assert.fail("expected a reconstructed plan-draft call")
  }
  assert.deepEqual(
    TodoItem.runtime.bin.listUnknownFields(roundTrip.message.value.tool.value.args!.todos[0]!),
    TodoItem.runtime.bin.listUnknownFields(todos[0]!),
  )

  const redactedStep = fromInteropToolCallStep(toRedactedToolCallInterop(new ToolCall({
    tool: { case: "createPlanToolCall", value: new CreatePlanToolCall({ args }) },
  }), PrivacyMode.NO_STORAGE))
  const redactedPlan = serde.deserialize(serde.serialize(redactedStep))
  assert.equal(redactedPlan.kind, "tool-call")
  if (redactedPlan.kind !== "tool-call" || redactedPlan.tool.kind !== "plan-draft") {
    assert.fail("expected a redacted plan-draft operation")
  }
  assert.equal(isRedactedString(redactedPlan.tool.args?.content), true)
  assert.equal(isRedactedString(redactedPlan.tool.args?.todos[0]?.content), true)
})

test("previous Slate plan tool-call envelopes migrate to the owned plan-draft operation", () => {
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const previous = createSlateToolCallStep({
    tool: {
      case: "createPlanToolCall",
      value: {
        args: { plan: "plan text", overview: "overview", name: "name", isProject: false, todos: [], phases: [] },
        result: { planUri: "slate-plan://plan", result: { case: "success", value: {} } },
      },
    },
  })
  const envelope = JSON.parse(
    new TextDecoder().decode(serde.serialize(previous)).slice("SLATE-AGENT-STEP\n".length),
  ) as { version: number; step: unknown; compatibility?: unknown }
  envelope.version = 1
  const migrated = serde.deserialize(new TextEncoder().encode(`SLATE-AGENT-STEP\n${JSON.stringify(envelope)}`))
  assert.equal(migrated.kind, "tool-call")
  if (migrated.kind !== "tool-call" || migrated.tool.kind !== "plan-draft") {
    assert.fail("expected the Slate plan-draft operation")
  }
  assert.equal(migrated.tool.args?.content, "plan text")
  assert.deepEqual(migrated.tool.result, { kind: "created", planUri: "slate-plan://plan" })
  const rewritten = new TextDecoder().decode(serde.serialize(migrated))
  assert.equal(JSON.parse(rewritten.slice("SLATE-AGENT-STEP\n".length)).version, 2)
  assert.match(rewritten, /"operation":"plan-draft"/)
  assert.doesNotMatch(rewritten, /createPlanToolCall/)
})

test("ask-question tool calls use Slate arguments and outcome values and rebuild at the boundary", () => {
  const sources = [
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "askQuestionToolCall", value: new AskQuestionToolCall({
        args: new AskQuestionArgs({
          title: "Choose a direction",
          questions: [new AskQuestionArgs_Question({
            id: "q-1",
            prompt: "Which path?",
            allowMultiple: true,
            options: [new AskQuestionArgs_Option({ id: "left", label: "Left" })],
          })],
          runAsync: true,
          asyncOriginalToolCallId: "call-1",
        }),
        result: new AskQuestionResult({
          result: { case: "success", value: new AskQuestionSuccess({ answers: [
            new AskQuestionSuccess_Answer({
              questionId: "q-1",
              selectedOptionIds: ["left", "unlisted"],
              freeformText: "additional detail",
            }),
          ] }) },
        }),
      }) },
    }) } }),
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "askQuestionToolCall", value: new AskQuestionToolCall({
        args: new AskQuestionArgs({ title: "Confirm", runAsync: false }),
        result: new AskQuestionResult({ result: { case: "async", value: new AskQuestionAsync() } }),
      }) },
    }) } }),
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "askQuestionToolCall", value: new AskQuestionToolCall({
        args: new AskQuestionArgs({ title: "Confirm" }),
        result: new AskQuestionResult({ result: { case: "rejected", value: new AskQuestionRejected({ reason: "not now" }) } }),
      }) },
    }) } }),
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "askQuestionToolCall", value: new AskQuestionToolCall({
        result: new AskQuestionResult({ result: { case: "error", value: new AskQuestionError({ errorMessage: "Tool call failed" }) } }),
      }) },
    }) } }),
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "askQuestionToolCall", value: new AskQuestionToolCall({ result: new AskQuestionResult() }) },
    }) } }),
  ]
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)

  for (const source of sources) {
    const projected = fromInteropConversationStep(source)
    assert.equal(projected.kind, "tool-call")
    if (projected.kind !== "tool-call") assert.fail("expected a tool call")
    assert.equal(projected.tool.kind, "ask-question")
    assert.equal(projected.tool.case, undefined)
    const stored = new TextDecoder().decode(serde.serialize(projected))
    assert.match(stored, /"operation":"ask-question"/)
    const restored = serde.deserialize(serde.serialize(projected))
    assert.equal(restored.kind, "tool-call")
    if (restored.kind !== "tool-call") assert.fail("expected a stored tool call")
    assert.equal(restored.tool.kind, "ask-question")
    assert.deepEqual(toInteropConversationStep(restored).toJson(), source.toJson())
  }

  const first = fromInteropConversationStep(sources[0]!)
  assert.equal(first.kind, "tool-call")
  if (first.kind !== "tool-call" || first.tool.kind !== "ask-question") assert.fail("expected Slate question data")
  assert.equal(first.tool.args?.responseMode, "deferred")
  assert.equal(first.tool.args?.originalCallId, "call-1")
  assert.deepEqual(first.tool.result, {
    kind: "answered",
    answers: [{ questionId: "q-1", selectedOptionIds: ["left", "unlisted"], freeformText: "additional detail" }],
  })
})

test("previous Slate ask-question operation names migrate to the owned operation on rewrite", () => {
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const previous = createSlateToolCallStep({
    tool: {
      case: "askQuestionToolCall",
      value: {
        args: {
          title: "Choose",
          questions: [{ id: "q-1", prompt: "Which?", allowMultiple: false, options: [{ id: "left", label: "Left" }] }],
          runAsync: true,
          asyncOriginalToolCallId: "call-1",
        },
        result: {
          result: {
            case: "success",
            value: { answers: [{ questionId: "q-1", selectedOptionIds: ["left"], freeformText: "" }] },
          },
        },
      },
    },
  })
  const envelope = JSON.parse(
    new TextDecoder().decode(serde.serialize(previous)).slice("SLATE-AGENT-STEP\n".length),
  ) as { version: number; step: unknown; compatibility?: unknown }
  envelope.version = 1
  const migrated = serde.deserialize(new TextEncoder().encode(`SLATE-AGENT-STEP\n${JSON.stringify(envelope)}`))
  assert.equal(migrated.kind, "tool-call")
  if (migrated.kind !== "tool-call" || migrated.tool.kind !== "ask-question") {
    assert.fail("expected the Slate ask-question operation")
  }
  assert.equal(migrated.tool.args?.responseMode, "deferred")
  assert.equal(migrated.tool.args?.originalCallId, "call-1")
  const rewritten = new TextDecoder().decode(serde.serialize(migrated))
  assert.equal(JSON.parse(rewritten.slice("SLATE-AGENT-STEP\n".length)).version, 2)
  assert.match(rewritten, /"operation":"ask-question"/)
  assert.doesNotMatch(rewritten, /askQuestionToolCall/)
})

test("ask-question args preserve redaction and nested unknown fields through migration", () => {
  const appendUnknownVarint = (bytes: Uint8Array): Uint8Array => {
    const result = new Uint8Array(bytes.length + 3)
    result.set(bytes)
    result.set([0xa0, 0x06, 0x07], bytes.length)
    return result
  }
  const option = AskQuestionArgs_Option.fromBinary(appendUnknownVarint(
    new AskQuestionArgs_Option({ id: "left", label: "Left" }).toBinary(),
  ))
  const source = new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
    tool: { case: "askQuestionToolCall", value: new AskQuestionToolCall({
      args: new AskQuestionArgs({
        title: "Choose",
        questions: [new AskQuestionArgs_Question({ id: "q-1", prompt: "Which?", options: [option] })],
      }),
    }) },
  }) } })
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const decoded = serde.deserialize(source.toBinary())
  const restored = toInteropConversationStep(decoded)

  assert.equal(decoded.kind, "tool-call")
  if (decoded.kind !== "tool-call" || decoded.tool.kind !== "ask-question") assert.fail("expected a Slate question operation")
  if (restored.message.case !== "toolCall" || restored.message.value.tool.case !== "askQuestionToolCall") {
    assert.fail("expected a restored question call")
  }
  const restoredArgs = restored.message.value.tool.value.args!
  const restoredOption = restoredArgs.questions[0]!.options[0]!
  assert.deepEqual(
    AskQuestionArgs_Option.runtime.bin.listUnknownFields(restoredOption),
    AskQuestionArgs_Option.runtime.bin.listUnknownFields(option),
  )

  const redactedCall = new ToolCall({
    tool: { case: "askQuestionToolCall", value: new AskQuestionToolCall({
      args: new AskQuestionArgs({
        title: "Choose",
        questions: [new AskQuestionArgs_Question({
          id: "q-1",
          prompt: "Which?",
          options: [new AskQuestionArgs_Option({ id: "left", label: "Left" })],
        })],
      }),
    }) },
  })
  const redactedStep = fromInteropToolCallStep(
    toRedactedToolCallInterop(redactedCall, PrivacyMode.NO_STORAGE),
  )
  const redactedDecoded = serde.deserialize(serde.serialize(redactedStep))
  assert.equal(redactedDecoded.kind, "tool-call")
  if (redactedDecoded.kind !== "tool-call" || redactedDecoded.tool.kind !== "ask-question") {
    assert.fail("expected a redacted Slate question operation")
  }
  const title = redactedDecoded.tool.args?.title
  assert.equal(isRedactedString(title) ? title.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : title, "Choose")
})

test("unknown nested summary fields survive the Slate operation projection", () => {
  const appendUnknownVarint = (bytes: Uint8Array): Uint8Array => {
    const result = new Uint8Array(bytes.length + 3)
    result.set(bytes)
    result.set([0xa0, 0x06, 0x07], bytes.length)
    return result
  }
  const args = SendFinalSummaryArgs.fromBinary(appendUnknownVarint(
    new SendFinalSummaryArgs({ finalSummary: "summary" }).toBinary(),
  ))
  const tool = new SendFinalSummaryToolCall({ args })
  const source = new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
    tool: { case: "sendFinalSummaryToolCall", value: tool },
  }) } })
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const projected = serde.deserialize(source.toBinary())
  const restored = toInteropConversationStep(serde.deserialize(serde.serialize(projected)))

  if (restored.message.case !== "toolCall") assert.fail("expected a tool call")
  const restoredTool = restored.message.value.tool
  if (restoredTool.case !== "sendFinalSummaryToolCall") assert.fail("expected a summary operation")
  assert.deepEqual(
    SendFinalSummaryArgs.runtime.bin.listUnknownFields(restoredTool.value.args!),
    SendFinalSummaryArgs.runtime.bin.listUnknownFields(args),
  )
})

test("step redaction records preserve raw text without relying on implicit JSON conversion", () => {
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const step = createSlateAssistantMessageStep(text("private text"))
  const bytes = serde.serialize(step)
  const json = new TextDecoder().decode(bytes)
  assert.match(json, /\"text\":\"private text\"/)
  assert.doesNotMatch(json, /\[redacted/)

  const decoded = serde.deserialize(bytes)
  assert.equal(decoded.kind, "assistant-message")
  if (decoded.kind === "assistant-message") {
    assert.equal(decoded.text.__classification, DataClassification.CODE)
    assert.equal(decoded.text.__fieldName, "text")
    assert.equal(decoded.text.__privacyMode, PrivacyMode.NO_STORAGE)
    assert.equal(decoded.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "private text")
  }
})

test("an unknown persisted step case becomes an explicit unsupported step", () => {
  const step = fromInteropConversationStep(new ConversationStep())

  assert.deepEqual(step, { kind: "unsupported" })
  assert.equal(toInteropConversationStep(step).message.case, undefined)
})

test("unknown fields in a legacy step and its nested tool payload survive a Slate rewrite", () => {
  const appendUnknownVarint = (bytes: Uint8Array): Uint8Array => {
    const result = new Uint8Array(bytes.length + 3)
    result.set(bytes)
    result.set([0xa0, 0x06, 0x07], bytes.length)
    return result
  }
  const tool = ToolCall.fromBinary(appendUnknownVarint(new ToolCall({
    tool: {
      case: "sendMessageToolCall",
      value: { args: { message: { case: "text", value: { content: "hello" } } } },
    } as never,
  }).toBinary()))
  const legacy = ConversationStep.fromBinary(appendUnknownVarint(new ConversationStep({
    message: { case: "toolCall", value: tool },
  }).toBinary()))
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const slate = serde.deserialize(legacy.toBinary())
  const stored = serde.deserialize(serde.serialize(slate))
  const restored = toInteropConversationStep(stored)

  assert.deepEqual(
    ConversationStep.runtime.bin.listUnknownFields(restored),
    ConversationStep.runtime.bin.listUnknownFields(legacy),
  )
  if (restored.message.case !== "toolCall" || legacy.message.case !== "toolCall") {
    throw new Error("turn step lost its tool-call case")
  }
  assert.deepEqual(
    ToolCall.runtime.bin.listUnknownFields(restored.message.value),
    ToolCall.runtime.bin.listUnknownFields(legacy.message.value),
  )
})

test("constructing a tool step copies hook contexts and retains the payload", () => {
  const hookContexts = [{ event: "postToolUse", text: text("notice") }]
  const tool = { case: undefined }
  const step = createSlateToolCallStep({ hookContexts, tool })

  assert.deepEqual(step.hookContexts, hookContexts)
  assert.notEqual(step.hookContexts, hookContexts)
  assert.equal(step.tool, tool)
})
