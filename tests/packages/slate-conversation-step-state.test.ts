import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createSlateAssistantMessageStep,
  createSlateComputerUseToolCall,
  createSlateThinkingMessageStep,
  createSlateToolCallStep,
  isSlateConversationSummaryToolCall,
  isSlateComputerUseToolCall,
  isSlateSendMessageToolCall,
  isSuccessfulSlateSendMessage,
  slateToolCallMetricLabel,
} from "../../source/packages/agent/conversation-step-state.ts"
import { createRedactedString } from "../../source/packages/redaction/create.ts"
import { isRedactedString } from "../../source/packages/redaction/redacted-values.ts"
import { DataClassification, PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { isSlateShellToolCall } from "../../source/packages/agent/shell-tool-call-state.ts"
import {
  createSlateConversationStepSerde,
  fromInteropConversationStep,
  fromInteropToolCallStep,
  toPlainInteropConversationStep,
  toInteropConversationStep,
} from "../../source/adapters/interop/agent/agent-state-message-serdes-adapter.ts"
import { toRedactedToolCallInterop } from "../../source/adapters/interop/agent/user-message-action-protocol-adapter.ts"
import {
  ConversationStep,
  ToolCall,
} from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  ShellArgs,
  ShellBackgroundReason,
  ShellResult,
  ShellSuccess,
  TimeoutBehavior,
} from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts"
import { ShellToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/shell_tool_pb.ts"
import {
  NetworkPolicy,
  NetworkPolicy_DefaultAction,
  SandboxPolicy,
  SandboxPolicy_ReadBoundaryMode,
  SandboxPolicy_Type,
} from "../../source/adapters/interop/proto/generated/agent/v1/sandbox_pb.ts"
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
import {
  SendMessageArgs,
  SendMessageAttachment,
  SendMessageError,
  SendMessageResult,
  SendMessageSuccess,
  SendMessageText,
  SendMessageToolCall,
} from "../../source/adapters/interop/proto/generated/agent/v1/send_message_tool_pb.ts"
import {
  ClickAction,
  ComputerUseAction,
  ComputerUseResult,
  ComputerUseSuccess,
  ComputerUseToolCall,
  Coordinate,
  CursorPositionAction,
  DragAction,
  KeyAction,
  MouseButton,
  MouseDownAction,
  MouseMoveAction,
  MouseUpAction,
  ScreenshotAction,
  ScrollAction,
  ScrollDirection,
  TypeAction,
  WaitAction,
} from "../../source/adapters/interop/proto/generated/agent/v1/computer_use_tool_pb.ts"

const text = (value: string) =>
  createRedactedString(value, DataClassification.CODE, "text", PrivacyMode.NO_STORAGE)

function storeLegacyStepValue(value: unknown): unknown {
  if (value === undefined) return { kind: "undefined" }
  if (value === null) return { kind: "null" }
  if (typeof value === "string") return { kind: "string", value }
  if (typeof value === "boolean") return { kind: "boolean", value }
  if (typeof value === "number") return { kind: "number", value }
  if (typeof value === "bigint") return { kind: "bigint", decimal: value.toString() }
  if (value instanceof Uint8Array) return { kind: "bytes", hex: Buffer.from(value).toString("hex") }
  if (Array.isArray(value)) return { kind: "array", entries: value.map(storeLegacyStepValue) }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return { kind: "object", entries: entries.map(([key, entry]) => [key, storeLegacyStepValue(entry)]) }
  }
  throw new TypeError(`cannot build a legacy step fixture from ${typeof value}`)
}

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

test("computer-use steps use Slate storage while preserving every legacy action and unknown enum", () => {
  const appendUnknownVarint = (bytes: Uint8Array): Uint8Array => {
    const result = new Uint8Array(bytes.length + 3)
    result.set(bytes)
    result.set([0xa0, 0x06, 0x07], bytes.length)
    return result
  }
  const click = ClickAction.fromBinary(appendUnknownVarint(new ClickAction({
    coordinate: new Coordinate({ x: 12, y: 5 }),
    button: 77 as MouseButton,
    count: 2,
    modifierKeys: "CTRL",
  }).toBinary()))
  const source = new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
    toolCallId: "outer-call",
    tool: { case: "computerUseToolCall", value: new ComputerUseToolCall({
      args: {
        toolCallId: "inner-call",
        description: "inspect the menu",
        bindUnmappedCharacters: true,
        actions: [
          new ComputerUseAction({ action: { case: "mouseMove", value: new MouseMoveAction({ coordinate: new Coordinate({ x: 1, y: 2 }) }) } }),
          new ComputerUseAction({ action: { case: "click", value: click } }),
          new ComputerUseAction({ action: { case: "mouseDown", value: new MouseDownAction({ button: MouseButton.LEFT }) } }),
          new ComputerUseAction({ action: { case: "mouseUp", value: new MouseUpAction({ button: MouseButton.RIGHT }) } }),
          new ComputerUseAction({ action: { case: "drag", value: new DragAction({ path: [new Coordinate({ x: 2, y: 3 }), new Coordinate({ x: 8, y: 9 })], button: MouseButton.LEFT, modifierKeys: "SHIFT" }) } }),
          new ComputerUseAction({ action: { case: "scroll", value: new ScrollAction({ coordinate: new Coordinate({ x: 4, y: 6 }), direction: ScrollDirection.DOWN, amount: 12 }) } }),
          new ComputerUseAction({ action: { case: "type", value: new TypeAction({ text: "hello" }) } }),
          new ComputerUseAction({ action: { case: "key", value: new KeyAction({ key: "ENTER", holdDurationMs: 250 }) } }),
          new ComputerUseAction({ action: { case: "wait", value: new WaitAction({ durationMs: 30 }) } }),
          new ComputerUseAction({ action: { case: "screenshot", value: new ScreenshotAction() } }),
          new ComputerUseAction({ action: { case: "cursorPosition", value: new CursorPositionAction() } }),
          new ComputerUseAction(),
        ],
      },
      result: new ComputerUseResult({ result: { case: "success", value: new ComputerUseSuccess({
        actionCount: 11,
        durationMs: 420,
        screenshot: "image-data",
        log: "completed",
        screenshotPath: "/tmp/screen.png",
        cursorPosition: new Coordinate({ x: 20, y: 21 }),
      }) } }),
    }) },
  }) } })
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const projected = serde.deserialize(source.toBinary())
  assert.equal(projected.kind, "tool-call")
  if (projected.kind !== "tool-call" || !isSlateComputerUseToolCall(projected.tool)) {
    assert.fail("expected a Slate computer-use operation")
  }
  assert.deepEqual(projected.tool.args?.actions.map(action => action.kind), [
    "mouse-move", "click", "mouse-down", "mouse-up", "drag", "scroll",
    "type", "key", "wait", "screenshot", "cursor-position", "missing",
  ])
  const clickAction = projected.tool.args?.actions[1]
  assert.equal(clickAction?.kind, "click")
  if (clickAction?.kind !== "click") assert.fail("expected a click action")
  assert.deepEqual(clickAction.button, { kind: "unknown", code: 77 })

  const storedBytes = serde.serialize(projected)
  const storedText = new TextDecoder().decode(storedBytes)
  const envelope = JSON.parse(storedText.slice("SLATE-AGENT-STEP\n".length)) as {
    version: number
    step: { tool: { operation: string; payload: { kind: string }; case?: string } }
    compatibility?: { legacyUnknownFields?: Array<{ path: Array<{ field?: string; index?: number; key?: string }> }> }
  }
  assert.equal(envelope.version, 3)
  assert.equal(envelope.step.tool.operation, "computer-use")
  assert.equal(envelope.step.tool.payload.kind, "object")
  assert.match(storedText, /"computer-use"/)
  assert.match(storedText, /"mouse-move"/)

  const restored = toPlainInteropConversationStep(serde.deserialize(storedBytes))
  assert.deepEqual(restored.toJson(), source.toJson())
  if (restored.message.case !== "toolCall" || restored.message.value.tool.case !== "computerUseToolCall") {
    assert.fail("expected the legacy boundary projection")
  }
  const restoredClick = restored.message.value.tool.value.args!.actions[1]!.action
  if (restoredClick.case !== "click") assert.fail("expected the restored click action")
  assert.deepEqual(
    ClickAction.runtime.bin.listUnknownFields(restoredClick.value),
    ClickAction.runtime.bin.listUnknownFields(click),
  )
})

test("shell tool calls use a typed Slate step operation and preserve redaction and nested unknown fields", () => {
  const args = new ShellArgs({
    command: "pnpm test",
    workingDirectory: "/workspace",
    timeout: 3_000,
    toolCallId: "shell-call-1",
    simpleCommands: ["pnpm"],
    hasOutputRedirect: true,
    requestedSandboxPolicy: new SandboxPolicy({
      type: SandboxPolicy_Type.WORKSPACE_READWRITE,
      networkAccess: false,
      additionalReadwritePaths: ["/workspace"],
    }),
    isBackground: true,
    timeoutBehavior: TimeoutBehavior.BACKGROUND,
    hardTimeout: 30_000,
    description: "run the package tests",
    closeStdin: false,
    adminCommandDenylist: ["rm"],
  })
  ShellArgs.runtime.bin.onUnknownField(args, 701, 0, new Uint8Array([7]))
  const success = new ShellSuccess({
    command: "pnpm test",
    workingDirectory: "/workspace",
    exitCode: 0,
    signal: "",
    stdout: "all passed\n",
    stderr: "",
    executionTime: 12,
    shellId: 17,
    interleavedOutput: "all passed\n",
    pid: 42,
    msToWait: 3_000,
    backgroundReason: ShellBackgroundReason.TIMEOUT,
  })
  ShellSuccess.runtime.bin.onUnknownField(success, 702, 0, new Uint8Array([9]))
  const source = new ConversationStep({
    message: {
      case: "toolCall",
      value: new ToolCall({
        toolCallId: "shell-call-1",
        startedAtMs: 100n,
        completedAtMs: 112n,
        tool: {
          case: "shellToolCall",
          value: new ShellToolCall({
            args,
            result: new ShellResult({ result: { case: "success", value: success }, isBackground: true, terminalsFolder: "/tmp/terminals", pid: 42 }),
          }),
        },
      }),
    },
  })
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const slate = serde.deserialize(source.toBinary())
  if (slate.kind !== "tool-call" || !isSlateShellToolCall(slate.tool)) {
    assert.fail("expected a Slate shell operation")
  }
  assert.equal(slateToolCallMetricLabel(slate.tool), "shell")
  assert.equal(slate.tool.args?.command === undefined ? undefined : isRedactedString(slate.tool.args.command), true)
  if (slate.tool.args === undefined || !isRedactedString(slate.tool.args.command)) assert.fail("expected redacted shell command")
  assert.equal(slate.tool.args.command.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "pnpm test")
  assert.equal(slate.tool.args.command.__classification, DataClassification.CODE)
  assert.equal(slate.tool.args.command.__fieldName, "command")
  assert.equal(slate.tool.result?.isBackground, true)
  if (slate.tool.result?.outcome.kind !== "success") assert.fail("expected a successful shell result")
  assert.equal(isRedactedString(slate.tool.result.outcome.stdout), true)
  if (!isRedactedString(slate.tool.result.outcome.stdout)) assert.fail("expected redacted shell output")
  assert.equal(slate.tool.result.outcome.stdout.__fieldName, "stdout")

  const stored = serde.serialize(slate)
  const storedText = new TextDecoder().decode(stored)
  const envelope = JSON.parse(storedText.slice("SLATE-AGENT-STEP\n".length)) as {
    version: number
    step: { tool: { operation: string; payload: { kind: string }; case?: string } }
    compatibility?: { legacyUnknownFields?: Array<{ path: Array<{ field?: string; index?: number; key?: string }> }> }
  }
  assert.equal(envelope.version, 3)
  assert.equal(envelope.step.tool.operation, "shell")
  assert.equal(envelope.step.tool.payload.kind, "object")
  assert.equal(envelope.step.tool.case, undefined)
  assert.deepEqual(envelope.compatibility?.legacyUnknownFields?.map(field => field.path), [
    [{ field: "toolCall" }, { field: "shellToolCall" }, { field: "args" }],
    [{ field: "toolCall" }, { field: "shellToolCall" }, { field: "result" }, { field: "success" }],
  ])

  const decoded = serde.deserialize(stored)
  const redactedInterop = toInteropConversationStep(decoded)
  if (redactedInterop.message.case !== "toolCall" || redactedInterop.message.value.tool.case !== "shellToolCall") {
    assert.fail("expected the redacted shell operation at the interaction boundary")
  }
  const redactedArgs = redactedInterop.message.value.tool.value.args as unknown as { readonly command: unknown } | undefined
  assert.ok(redactedArgs !== undefined && isRedactedString(redactedArgs.command))
  const redactedResult = redactedInterop.message.value.tool.value.result?.result
  if (redactedResult?.case !== "success") assert.fail("expected the redacted shell result")
  assert.ok(isRedactedString(redactedResult.value.stdout))

  const restored = toPlainInteropConversationStep(decoded)
  if (restored.message.case !== "toolCall" || restored.message.value.tool.case !== "shellToolCall") {
    assert.fail("expected the shell operation to project at the transcript boundary")
  }
  const restoredArgs = restored.message.value.tool.value.args
  const restoredSuccess = restored.message.value.tool.value.result?.result.value
  assert.ok(restoredArgs instanceof ShellArgs)
  assert.ok(restoredSuccess instanceof ShellSuccess)
  if (!(restoredArgs instanceof ShellArgs) || !(restoredSuccess instanceof ShellSuccess)) assert.fail("expected complete shell messages")
  assert.equal(restoredArgs.command, "pnpm test")
  assert.equal(restoredArgs.workingDirectory, "/workspace")
  assert.deepEqual(restoredArgs.simpleCommands, ["pnpm"])
  assert.equal(restoredArgs.requestedSandboxPolicy?.networkAccess, false)
  assert.equal(restoredArgs.requestedSandboxPolicy?.networkPolicy?.defaultAction, NetworkPolicy_DefaultAction.DENY)
  assert.equal(restoredSuccess.stdout, "all passed\n")
  assert.equal(restoredSuccess.backgroundReason, ShellBackgroundReason.TIMEOUT)
  assert.deepEqual(ShellArgs.runtime.bin.listUnknownFields(restoredArgs), ShellArgs.runtime.bin.listUnknownFields(args))
  assert.deepEqual(ShellSuccess.runtime.bin.listUnknownFields(restoredSuccess), ShellSuccess.runtime.bin.listUnknownFields(success))
})

test("stored V2 shell payloads migrate to the Slate operation and rewrite as V3", () => {
  const shellCall = new ShellToolCall({
    args: new ShellArgs({ command: "git diff", workingDirectory: "/repo", toolCallId: "legacy-shell" }),
    result: new ShellResult({ result: { case: "success", value: new ShellSuccess({
      command: "git diff",
      workingDirectory: "/repo",
      exitCode: 0,
      signal: "",
      stdout: "clean",
      stderr: "",
      executionTime: 4,
      interleavedOutput: "clean",
    }) } }),
  })
  const oldEnvelope = {
    format: "slate.agent-conversation-step",
    version: 2,
    step: {
      kind: "tool-call",
      toolCallId: "legacy-shell",
      hookContexts: [],
      tool: { operation: "shellToolCall", payload: storeLegacyStepValue(shellCall) },
    },
  }
  const bytes = new TextEncoder().encode(`SLATE-AGENT-STEP\n${JSON.stringify(oldEnvelope)}`)
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const migrated = serde.deserialize(bytes)
  if (migrated.kind !== "tool-call" || !isSlateShellToolCall(migrated.tool)) {
    assert.fail("expected the V2 shell payload to migrate to Slate")
  }
  assert.equal(migrated.tool.args?.command, "git diff")
  if (migrated.tool.result?.outcome.kind !== "success") assert.fail("expected the shell result to migrate")
  assert.equal(migrated.tool.result.outcome.stdout, "clean")

  const rewritten = serde.serialize(migrated)
  const envelope = JSON.parse(new TextDecoder().decode(rewritten).slice("SLATE-AGENT-STEP\n".length)) as {
    version: number
    step: { tool: { operation: string; payload: { kind: string } } }
  }
  assert.equal(envelope.version, 3)
  assert.equal(envelope.step.tool.operation, "shell")
  assert.equal(envelope.step.tool.payload.kind, "object")
  const restored = toPlainInteropConversationStep(serde.deserialize(rewritten))
  if (restored.message.case !== "toolCall" || restored.message.value.tool.case !== "shellToolCall") {
    assert.fail("expected the Slate operation to project to the current transcript view")
  }
  assert.equal(restored.message.value.tool.value.args?.command, "git diff")
  const restoredShellResult = restored.message.value.tool.value.result
  if (restoredShellResult === undefined || restoredShellResult.result.case !== "success") {
    assert.fail("expected a successful restored shell result")
  }
  assert.equal(restoredShellResult.result.value.stdout, "clean")
})

test("unmapped sandbox enum values remain lossless legacy shell data", () => {
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const policies = [
    new SandboxPolicy({ type: SandboxPolicy_Type.UNSPECIFIED }),
    new SandboxPolicy({ type: 77 as SandboxPolicy_Type }),
    new SandboxPolicy({
      type: SandboxPolicy_Type.WORKSPACE_READWRITE,
      readBoundary: SandboxPolicy_ReadBoundaryMode.CUSTOM,
      additionalReadPaths: ["/workspace/private"],
    }),
    new SandboxPolicy({
      type: SandboxPolicy_Type.WORKSPACE_READWRITE,
      networkPolicy: new NetworkPolicy({ defaultAction: 77 as NetworkPolicy_DefaultAction, allow: ["internal"] }),
    }),
  ]
  for (const policy of policies) {
    const source = new ConversationStep({
      message: {
        case: "toolCall",
        value: new ToolCall({
          tool: {
            case: "shellToolCall",
            value: new ShellToolCall({ args: new ShellArgs({ command: "echo preserved", requestedSandboxPolicy: policy }) }),
          },
        }),
      },
    })
    const imported = serde.deserialize(source.toBinary())
    if (imported.kind !== "tool-call" || isSlateShellToolCall(imported.tool) || imported.tool.case !== "shellToolCall") {
      assert.fail("expected an unmapped sandbox enum to remain in the migration payload")
    }
    const encoded = serde.serialize(imported)
    const envelope = JSON.parse(new TextDecoder().decode(encoded).slice("SLATE-AGENT-STEP\n".length)) as {
      version: number
      step: { tool: { operation: string } }
    }
    assert.equal(envelope.version, 3)
    assert.equal(envelope.step.tool.operation, "shellToolCall")

    const restored = toPlainInteropConversationStep(serde.deserialize(encoded))
    if (restored.message.case !== "toolCall" || restored.message.value.tool.case !== "shellToolCall") {
      assert.fail("expected legacy shell data to remain readable")
    }
    const restoredPolicy = restored.message.value.tool.value.args?.requestedSandboxPolicy
    assert.equal(restoredPolicy?.type, policy.type)
    assert.equal(restoredPolicy?.readBoundary, policy.readBoundary)
    assert.equal(restoredPolicy?.networkPolicy?.defaultAction, policy.networkPolicy?.defaultAction)
    assert.deepEqual(restoredPolicy?.networkPolicy?.allow, policy.networkPolicy?.allow)
  }
})

test("malformed Slate shell calls are rejected before write and during V3 recovery", () => {
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const invalid = { kind: "shell", args: { command: "echo invalid", timeout: "later" } }
  assert.equal(isSlateShellToolCall(invalid), false)
  assert.throws(
    () => serde.serialize(createSlateToolCallStep({ tool: invalid as never })),
    /Slate shell operation is invalid/,
  )

  const envelope = {
    format: "slate.agent-conversation-step",
    version: 3,
    step: {
      kind: "tool-call",
      hookContexts: [],
      tool: { operation: "shell", payload: storeLegacyStepValue(invalid) },
    },
  }
  const bytes = new TextEncoder().encode(`SLATE-AGENT-STEP\n${JSON.stringify(envelope)}`)
  assert.throws(() => serde.deserialize(bytes), /Stored Slate shell operation is invalid/)
})

test("previous computer-use step data migrates to the Slate-owned operation on rewrite", () => {
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const previous = createSlateToolCallStep({ tool: {
    case: "computerUseToolCall",
    value: {
      args: {
        toolCallId: "legacy-call",
        actions: [{ action: { case: "click", value: { button: MouseButton.LEFT, count: 1 } } }],
      },
      result: { result: { case: "success", value: { actionCount: 1, durationMs: 5 } } },
    },
  } })
  const envelope = JSON.parse(
    new TextDecoder().decode(serde.serialize(previous)).slice("SLATE-AGENT-STEP\n".length),
  ) as { version: number; step: unknown }
  envelope.version = 1
  const migrated = serde.deserialize(new TextEncoder().encode(`SLATE-AGENT-STEP\n${JSON.stringify(envelope)}`))
  assert.equal(migrated.kind, "tool-call")
  if (migrated.kind !== "tool-call" || migrated.tool.kind !== "computer-use") {
    assert.fail("expected a migrated Slate computer-use operation")
  }
  assert.equal(migrated.tool.args?.originalCallId, "legacy-call")
  assert.deepEqual(migrated.tool.args?.actions[0], {
    kind: "click",
    button: "left",
    count: 1,
  })
  const rewritten = new TextDecoder().decode(serde.serialize(migrated))
  assert.equal(JSON.parse(rewritten.slice("SLATE-AGENT-STEP\n".length)).version, 3)
  assert.match(rewritten, /"operation":"computer-use"/)
  assert.doesNotMatch(rewritten, /computerUseToolCall/)
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

test("send-message text stays redaction-aware through the Slate operation serde", () => {
  const plain = new ToolCall({
    toolCallId: "call-1",
    tool: {
      case: "sendMessageToolCall",
      value: new SendMessageToolCall({
        args: new SendMessageArgs({ message: { case: "text", value: new SendMessageText({ content: "hello" }) } }),
      }),
    },
  })
  const step = fromInteropToolCallStep(
    toRedactedToolCallInterop(plain, PrivacyMode.NO_STORAGE),
    "call-1",
  )
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const decoded = serde.deserialize(serde.serialize(step))

  assert.equal(decoded.kind, "tool-call")
  if (decoded.kind === "tool-call" && decoded.tool.kind === "send-message") {
    assert.equal(decoded.tool.case, undefined)
    const content = decoded.tool.args?.message?.kind === "text" ? decoded.tool.args.message.content : undefined
    assert.equal(isRedactedString(content), true)
    if (!isRedactedString(content)) assert.fail("expected redacted send-message text")
    assert.equal(
      content?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      "hello",
    )
    assert.equal(content?.__classification, DataClassification.CODE)
    assert.equal(content?.__privacyMode, PrivacyMode.NO_STORAGE)
  } else {
    assert.fail("expected the Slate send-message operation")
  }
})

test("send-message text, attachment, and delivery outcomes use Slate values", () => {
  const sources = [
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "sendMessageToolCall", value: new SendMessageToolCall({
        args: new SendMessageArgs({ message: { case: "text", value: new SendMessageText({ content: "A delivered message" }) } }),
        result: new SendMessageResult({ result: {
          case: "success",
          value: new SendMessageSuccess({ timestamp: 1720000000123n, messageId: "message-1" }),
        } }),
      }) },
    }) } }),
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "sendMessageToolCall", value: new SendMessageToolCall({
        args: new SendMessageArgs({ message: { case: "attachment", value: new SendMessageAttachment({ url: "file:///tmp/report.pdf", alt: "Report" }) } }),
        result: new SendMessageResult({ result: { case: "error", value: new SendMessageError({ error: "delivery failed" }) } }),
      }) },
    }) } }),
    new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
      tool: { case: "sendMessageToolCall", value: new SendMessageToolCall({
        args: new SendMessageArgs(),
        result: new SendMessageResult(),
      }) },
    }) } }),
  ]
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const slateCalls = sources.map(source => fromInteropConversationStep(source))

  for (const [index, source] of sources.entries()) {
    const step = slateCalls[index]!
    assert.equal(step.kind, "tool-call")
    if (step.kind !== "tool-call") assert.fail("expected a tool call")
    assert.equal(step.tool.kind, "send-message")
    assert.equal(step.tool.case, undefined)
    const stored = new TextDecoder().decode(serde.serialize(step))
    assert.match(stored, /"operation":"send-message"/)
    const restored = serde.deserialize(serde.serialize(step))
    assert.deepEqual(toInteropConversationStep(restored).toJson(), source.toJson())
  }

  const first = slateCalls[0]!
  assert.equal(first.kind, "tool-call")
  if (first.kind !== "tool-call" || first.tool.kind !== "send-message") assert.fail("expected a Slate send-message operation")
  assert.equal(isSlateSendMessageToolCall(first.tool), true)
  assert.equal(isSuccessfulSlateSendMessage(first.tool), true)
  assert.equal(slateToolCallMetricLabel(first.tool), "sendMessage")
  assert.deepEqual(first.tool.result, { kind: "delivered", timestampMs: 1720000000123n, messageId: "message-1" })
  const failed = slateCalls[1]!
  assert.equal(failed.kind, "tool-call")
  if (failed.kind !== "tool-call" || failed.tool.kind !== "send-message") assert.fail("expected a Slate send-message operation")
  assert.equal(isSuccessfulSlateSendMessage(failed.tool), false)
  assert.equal(slateToolCallMetricLabel(failed.tool), "sendMessage")
})

test("previous Slate send-message tool records migrate and nested unknown fields survive", () => {
  const serde = createSlateConversationStepSerde(PrivacyMode.NO_STORAGE)
  const previous = createSlateToolCallStep({
    tool: {
      case: "sendMessageToolCall",
      value: {
        args: { message: { case: "text", value: { content: "legacy message" } } },
        result: { result: { case: "success", value: { timestamp: 9n, messageId: "legacy-id" } } },
      },
    },
  })
  const envelope = JSON.parse(
    new TextDecoder().decode(serde.serialize(previous)).slice("SLATE-AGENT-STEP\n".length),
  ) as { version: number; step: unknown; compatibility?: unknown }
  envelope.version = 1
  const migrated = serde.deserialize(new TextEncoder().encode(`SLATE-AGENT-STEP\n${JSON.stringify(envelope)}`))
  assert.equal(migrated.kind, "tool-call")
  if (migrated.kind !== "tool-call" || migrated.tool.kind !== "send-message") assert.fail("expected Slate send-message data")
  assert.deepEqual(migrated.tool.result, { kind: "delivered", timestampMs: 9n, messageId: "legacy-id" })
  const rewritten = new TextDecoder().decode(serde.serialize(migrated))
  assert.equal(JSON.parse(rewritten.slice("SLATE-AGENT-STEP\n".length)).version, 3)
  assert.match(rewritten, /"operation":"send-message"/)
  assert.doesNotMatch(rewritten, /sendMessageToolCall/)

  const appendUnknownVarint = (bytes: Uint8Array): Uint8Array => {
    const result = new Uint8Array(bytes.length + 3)
    result.set(bytes)
    result.set([0xa0, 0x06, 0x07], bytes.length)
    return result
  }
  const textMessage = SendMessageText.fromBinary(appendUnknownVarint(new SendMessageText({ content: "with unknown" }).toBinary()))
  const source = new ConversationStep({ message: { case: "toolCall", value: new ToolCall({
    tool: { case: "sendMessageToolCall", value: new SendMessageToolCall({
      args: new SendMessageArgs({ message: { case: "text", value: textMessage } }),
    }) },
  }) } })
  const restored = toInteropConversationStep(serde.deserialize(serde.serialize(serde.deserialize(source.toBinary()))))
  if (restored.message.case !== "toolCall" || restored.message.value.tool.case !== "sendMessageToolCall") {
    assert.fail("expected a restored send-message call")
  }
  const restoredMessage = restored.message.value.tool.value.args!.message
  if (restoredMessage.case !== "text") assert.fail("expected a text message")
  assert.deepEqual(
    SendMessageText.runtime.bin.listUnknownFields(restoredMessage.value),
    SendMessageText.runtime.bin.listUnknownFields(textMessage),
  )
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
    assert.equal(JSON.parse(storedText.slice("SLATE-AGENT-STEP\n".length)).version, 3)
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
  assert.equal(JSON.parse(rewritten.slice("SLATE-AGENT-STEP\n".length)).version, 3)
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
  assert.equal(JSON.parse(rewritten.slice("SLATE-AGENT-STEP\n".length)).version, 3)
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
  assert.equal(JSON.parse(rewritten.slice("SLATE-AGENT-STEP\n".length)).version, 3)
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
