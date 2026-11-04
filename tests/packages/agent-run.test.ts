import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext } from "../../source/packages/context/context.ts"
import { loggerKey, type ContextLogEntry } from "../../source/packages/context/logging.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { ToolErrorClassification } from "../../source/packages/agent/tools/tool-errors.ts"
import { SubagentModelForcePolicy } from "../../source/packages/agent/tools/subagent-model-policy.ts"
import { resolveForcedSubagentModel } from "../../source/packages/agent/tools/subagent-forced-model-resolution.ts"
import { classifyMcpErrorMessage } from "../../source/packages/agent/tools/mcp/error-classification.ts"
import {
  fingerprintMcpApprovalTarget,
  createMcpApprovalRequest,
  cancelMcpApprovalRequest,
} from "../../source/packages/agent/tools/mcp/smart-mode-approval.ts"
import { warnIfLongTrailingUserMessageRun } from "../../source/packages/agent/actions/user-message-action/user-message-run-warning.ts"
import { partitionDynamicTools } from "../../source/packages/agent/tools/exclude-tools.ts"
import { conversationHistoryToCoreMessages } from "../../source/packages/agent/actions/user-message-action/conversation-history.ts"
import {
  buildRunStreamStateHandleOptions,
  createRunStreamStateUpdateWithFlush,
  shouldTrackAgentTypeChange,
} from "../../source/packages/agent/run-stream-lifecycle.ts"
import { SubscriptionWakeupActionHandler } from "../../source/packages/agent/actions/subscription-notification-action-handler.ts"
import {
  DETAILED_COMPACTION_PROMPT,
  MAX_SELF_SUMMARY_RETRIES,
  SELF_SUMMARY_CONTEXT_WINDOW_FRACTION,
  SELF_SUMMARY_NUM_TURNS,
  SELF_SUMMARIZATION_PROMPT,
  TAGGED_COMPACTION_INSTRUCTIONS,
} from "../../source/packages/agent/self-summary/constants.ts"
import { buildGitPullRequestsUserContent } from "../../source/packages/agent/git-pr-processing.ts"
import type { GitPullRequestPromptInput } from "../../source/packages/agent/git-pr-processing-contracts.ts"
import {
  createStreamingTodoParser,
  createTodoItem,
  formatTodosForSummarization,
  stringToTodoStatus,
  todoStatusToString,
} from "../../source/packages/agent/tools/core/todo/common.ts"
import { ConversationStateStructure } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { toRedactedConversationStateStructure } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/agent_redacted.ts"
import { createContext as makeContext } from "../../source/packages/context/context.ts"

const ctx = () => createContext()

function contextWithLogs() {
  const entries: ContextLogEntry[] = []
  const context = createContext().with(loggerKey, {
    log: (_context, entry) => { entries.push(entry) },
  })
  return { context, entries }
}

// ---------------------------------------------------------------------------------------------
// which model a subagent may be forced onto
// ---------------------------------------------------------------------------------------------

function forceArgs(overrides: Record<string, unknown> = {}) {
  const logged: Record<string, unknown>[] = []
  return {
    logged,
    args: {
      forceModelId: "composer-2.5",
      subagentModelForcePolicy: SubagentModelForcePolicy.ParentPin as string,
      isModelBlocked: () => false,
      isMaxModeCompatible: async () => true,
      isModelValid: () => true,
      logForcedModel: (entry: Record<string, unknown>) => {
        logged.push(entry)
        return String(entry.candidateModelId)
      },
      ...overrides,
    },
  }
}

test("no policy means no forced model", async () => {
  const { args } = forceArgs({ subagentModelForcePolicy: SubagentModelForcePolicy.None })
  assert.equal(await resolveForcedSubagentModel(args as never), undefined)
})

test("a pinned model is used when it is usable, and reported as such", async () => {
  const { args, logged } = forceArgs()
  assert.equal(await resolveForcedSubagentModel(args as never), "composer-2.5")
  assert.equal(logged[0]?.modelResolutionReason, "force_model")

  const blocked = forceArgs({ isModelBlocked: () => true })
  assert.equal(await resolveForcedSubagentModel(blocked.args as never), undefined)

  const incompatible = forceArgs({ isMaxModeCompatible: async () => false })
  assert.equal(await resolveForcedSubagentModel(incompatible.args as never), undefined)

  const missing = forceArgs({ forceModelId: undefined })
  assert.equal(await resolveForcedSubagentModel(missing.args as never), undefined)
})

test("a request-based session prefers the user's own pick of the family", async () => {
  const { args, logged } = forceArgs({
    subagentModelForcePolicy: SubagentModelForcePolicy.RequestBasedComposer,
    userRequestedModelId: "composer-2.5-fast",
  })
  assert.equal(await resolveForcedSubagentModel(args as never), "composer-2.5-fast")
  assert.equal(logged[0]?.modelResolutionReason, "force_model_user_composer_selection")
})

test("a pick outside the family falls back to the pinned model", async () => {
  const { args, logged } = forceArgs({
    subagentModelForcePolicy: SubagentModelForcePolicy.RequestBasedComposer,
    userRequestedModelId: "gpt-5",
  })
  assert.equal(await resolveForcedSubagentModel(args as never), "composer-2.5")
  assert.equal(logged[0]?.modelResolutionReason, "force_model")

  // A pick that is not in the catalogue falls back to the pinned model.
  const unknownPick = forceArgs({
    subagentModelForcePolicy: SubagentModelForcePolicy.RequestBasedComposer,
    userRequestedModelId: "composer-2.5",
    isModelValid: () => false,
  })
  assert.equal(await resolveForcedSubagentModel(unknownPick.args as never), "composer-2.5")

  // When the pinned model itself is unusable there is nothing to fall back to, whatever the pick was.
  for (const unusable of [
    { isModelBlocked: () => true },
    { isMaxModeCompatible: async () => false },
  ]) {
    const attempt = forceArgs({
      subagentModelForcePolicy: SubagentModelForcePolicy.RequestBasedComposer,
      userRequestedModelId: "composer-2.5",
      ...unusable,
    })
    assert.equal(await resolveForcedSubagentModel(attempt.args as never), undefined)
  }
})

test("a policy this build does not know is refused rather than ignored", async () => {
  const { args } = forceArgs({ subagentModelForcePolicy: "something-new" })
  await assert.rejects(resolveForcedSubagentModel(args as never), /Unhandled subagent model force policy/)
})

// ---------------------------------------------------------------------------------------------
// MCP error classification
// ---------------------------------------------------------------------------------------------

test("an authentication failure is recognized by its words", () => {
  assert.equal(classifyMcpErrorMessage("Server requires authentication"), ToolErrorClassification.MCP_AUTH_ERROR)
  assert.equal(classifyMcpErrorMessage("invalid_grant"), ToolErrorClassification.MCP_AUTH_ERROR)
  assert.equal(classifyMcpErrorMessage("HTTP 401 from server"), ToolErrorClassification.MCP_AUTH_ERROR)
})

test("a JSON-RPC code decides the kind of failure", () => {
  assert.equal(classifyMcpErrorMessage("MCP error -32700: parse error"), ToolErrorClassification.INVALID_ARGS)
  assert.equal(classifyMcpErrorMessage("MCP error -32602: bad params"), ToolErrorClassification.INVALID_ARGS)
  assert.equal(classifyMcpErrorMessage("MCP error -32601: no such method"), ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
  assert.equal(classifyMcpErrorMessage("MCP error -32001: timed out"), ToolErrorClassification.TIMEOUT)
  assert.equal(classifyMcpErrorMessage("MCP error -32000: rate limited"), ToolErrorClassification.OTHER_ERROR)
})

test("a broken connection is read from its words, because the code is reused", () => {
  assert.equal(classifyMcpErrorMessage("MCP error -32000: connection closed"), ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
  assert.equal(classifyMcpErrorMessage("connect ECONNREFUSED"), ToolErrorClassification.UNEXPECTED_ENVIRONMENT)
  assert.equal(classifyMcpErrorMessage("connection timed out after 30s"), ToolErrorClassification.TIMEOUT)
})

test("a message that says nothing recognizable is left unclassified", () => {
  assert.equal(classifyMcpErrorMessage("the tool did something odd"), undefined)
})

// ---------------------------------------------------------------------------------------------
// MCP approvals
// ---------------------------------------------------------------------------------------------

test("the fingerprint depends on the call's values and not on their shape", () => {
  const base = {
    serverIdentifier: "s",
    toolName: "t",
    mcpMode: "meta",
    mcpArguments: { b: 2, a: 1, c: undefined },
    blockReason: "blocked",
  }
  const reordered = { ...base, mcpArguments: { a: 1, b: 2 } }
  assert.equal(
    fingerprintMcpApprovalTarget(base),
    fingerprintMcpApprovalTarget(reordered),
  )
  assert.notEqual(
    fingerprintMcpApprovalTarget(base),
    fingerprintMcpApprovalTarget({ ...base, toolName: "other" }),
  )
  assert.notEqual(
    fingerprintMcpApprovalTarget(base),
    fingerprintMcpApprovalTarget({ ...base, mcpArguments: { a: 2, b: 2 } }),
  )
  assert.equal(
    fingerprintMcpApprovalTarget(base),
    fingerprintMcpApprovalTarget({ ...base, blockReason: "a new display explanation" }),
    "a changed explanation does not turn the same tool request into a different action",
  )
  assert.notEqual(
    fingerprintMcpApprovalTarget(base),
    fingerprintMcpApprovalTarget({ ...base, toolDefinitionHash: "new-definition" }),
  )
})

test("an approval is recorded and can be cancelled", async () => {
  const created: unknown[] = []
  const deleted: string[] = []
  const store = {
    createPendingRequest: async (_ctx: unknown, request: unknown) => {
      created.push(request)
    },
    deletePendingRequest: async (_ctx: unknown, requestId: string) => {
      deleted.push(requestId)
    },
  }
  const context = makeContext().with(
    (await import("../../source/packages/agent/utils/request-scope.ts")).conversationIdKey,
    "conv-1",
  )
  const result = await createMcpApprovalRequest(context, store as never, {
    serverIdentifier: "s",
    toolName: "t",
    mcpMode: "meta",
    blockReason: "blocked",
  })
  assert.equal(result.conversationId, "conv-1")
  assert.equal(result.blockReason, "blocked")
  assert.equal(created.length, 1)
  assert.equal((created[0] as { fingerprint: string }).fingerprint, result.fingerprint)

  await cancelMcpApprovalRequest(context, store as never, result.requestId)
  assert.deepEqual(deleted, [result.requestId])
})

test("a conversation with no id cannot have an approval", async () => {
  const store = { createPendingRequest: async () => {}, deletePendingRequest: async () => {} }
  await assert.rejects(
    createMcpApprovalRequest(ctx(), store as never, {
      serverIdentifier: "s",
      toolName: "t",
      mcpMode: "meta",
      blockReason: "blocked",
    }),
    /require a conversation id/,
  )
})

// ---------------------------------------------------------------------------------------------
// the long trailing run of user messages
// ---------------------------------------------------------------------------------------------

test("a run of user messages with no answer in between is reported", () => {
  const { context, entries } = contextWithLogs()
  const messages = [{ role: "assistant", content: "previous answer" }, ...Array.from({ length: 5 }, (_, index) => ({ role: "user", content: `m${index}` }))]
  warnIfLongTrailingUserMessageRun(context, messages, "inv-1")

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.level, "warn")
  assert.equal(entries[0]?.message, "Turn contains unusually long trailing run of consecutive user messages")
  assert.deepEqual(entries[0]?.metadata, {
    trailingConsecutiveUserMessages: 5,
    threshold: 3,
    totalMessages: 6,
    invocationId: "inv-1",
    distanceToLastAssistant: 5,
    tailInspectionWindow: 12,
    tailRoles: ["assistant", "user", "user", "user", "user", "user"],
    tailProviderMessageIdCount: 0,
    distinctTailProviderMessageIdCount: 0,
    hasDuplicateTailProviderMessageIds: false,
    tailProviderRequestIdCount: 0,
    distinctTailProviderRequestIdCount: 0,
    hasDuplicateTailProviderRequestIds: false,
  })
})

test("a normal conversation, and a run of summaries, are not reported", () => {
  const { context, entries } = contextWithLogs()
  warnIfLongTrailingUserMessageRun(context, [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }], "inv-1")
  warnIfLongTrailingUserMessageRun(context, [{ role: "assistant", content: "ok" }], "inv-1")
  const summaries = Array.from({ length: 5 }, () => ({
    role: "user",
    content: "s",
    providerOptions: { cursor: { isSummary: true } },
  }))
  warnIfLongTrailingUserMessageRun(context, summaries, "inv-1")
  const notifications = Array.from({ length: 5 }, () => ({
    role: "user",
    content: '<system_notification source="test">wake</system_notification>',
  }))
  warnIfLongTrailingUserMessageRun(context, notifications, "inv-1")
  assert.deepEqual(entries, [])
})

test("the warning begins after three real trailing user messages", () => {
  const { context, entries } = contextWithLogs()
  warnIfLongTrailingUserMessageRun(context, Array.from({ length: 3 }, () => ({ role: "user", content: "m" })), "at-limit")
  assert.equal(entries.length, 0)

  warnIfLongTrailingUserMessageRun(context, Array.from({ length: 4 }, () => ({ role: "user", content: "m" })), "over-limit")
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.metadata?.trailingConsecutiveUserMessages, 4)
  assert.equal(entries[0]?.metadata?.threshold, 3)
})

test("the report counts duplicates among the tail's message ids", () => {
  const { context, entries } = contextWithLogs()
  const tail = [{ role: "assistant", content: "old answer" }, ...Array.from({ length: 13 }, () => ({
    role: "user",
    content: "m",
    providerOptions: { cursor: { messageId: "same", requestId: "req" } },
  }))]
  warnIfLongTrailingUserMessageRun(context, tail, "inv-1")
  const metadata = entries[0]?.metadata
  assert.equal(metadata?.distanceToLastAssistant, 13)
  assert.deepEqual(metadata?.tailRoles, Array.from({ length: 12 }, () => "user"))
  assert.equal(metadata?.tailInspectionWindow, 12)
  assert.equal(metadata?.tailProviderMessageIdCount, 12)
  assert.equal(metadata?.distinctTailProviderMessageIdCount, 1)
  assert.equal(metadata?.hasDuplicateTailProviderMessageIds, true)
  assert.equal(metadata?.tailProviderRequestIdCount, 12)
  assert.equal(metadata?.distinctTailProviderRequestIdCount, 1)
  assert.equal(metadata?.hasDuplicateTailProviderRequestIds, true)
})

// ---------------------------------------------------------------------------------------------
// which tools stay visible
// ---------------------------------------------------------------------------------------------

test("the all-static profile keeps everything visible", () => {
  const tools = [{ name: "read", toolIdentifier: "READ" }, { name: "custom", toolIdentifier: "OTHER" }]
  const partitioned = partitionDynamicTools(tools, "all-static")
  assert.equal(partitioned.staticTools.length, 2)
  assert.equal(partitioned.dynamicTools.length, 0)
})

test("the final profile holds back what is not a native tool, and keeps the question tool", () => {
  const tools = [
    { name: "read", toolIdentifier: "READ" },
    { name: "shell", toolIdentifier: "SHELL" },
    { name: "ask", toolIdentifier: "ASK_QUESTION" },
    { name: "custom", toolIdentifier: "OTHER" },
  ]
  const partitioned = partitionDynamicTools(tools, "final")
  assert.deepEqual(partitioned.staticTools.map(tool => tool.toolIdentifier), ["READ", "SHELL", "ASK_QUESTION"])
  assert.deepEqual(partitioned.dynamicTools.map(tool => tool.toolIdentifier), ["OTHER"])
})

test("a meta tool, a wire-formatted tool and a forced-static context always stay visible", () => {
  const tools = [
    { name: "meta", toolIdentifier: "OTHER", dynamicToolMetaRole: "discovery" },
    { name: "wire", toolIdentifier: "OTHER", customToolFormat: {} },
    { name: "static", toolIdentifier: "OTHER", contextType: { type: "static" } },
    { name: "plain", toolIdentifier: "OTHER" },
  ]
  const partitioned = partitionDynamicTools(tools, "final")
  assert.deepEqual(partitioned.staticTools.map(tool => tool.name), ["meta", "wire", "static"])
  assert.deepEqual(partitioned.dynamicTools.map(tool => tool.name), ["plain"])
})

test("the platform's communication tools stay visible so a subagent can be refused them", () => {
  const partitioned = partitionDynamicTools([
    { name: "SendSlackMessage", toolIdentifier: "PLATFORM_ACTION" },
    { name: "SendEmail", toolIdentifier: "PLATFORM_ACTION" },
  ], "final")
  assert.deepEqual(partitioned.staticTools.map(tool => tool.name), ["SendSlackMessage"])
  assert.deepEqual(partitioned.dynamicTools.map(tool => tool.name), ["SendEmail"])
})

// ---------------------------------------------------------------------------------------------
// conversation history carried on a message
// ---------------------------------------------------------------------------------------------

function historyMessage(kind: string, value: unknown) {
  return { message: { case: kind, value } }
}

test("an assistant message with one text part collapses back to its text", () => {
  const messages = conversationHistoryToCoreMessages({
    messages: [historyMessage("assistant", { content: [{ content: { case: "text", value: { text: "hello" } } }] })],
  })
  assert.deepEqual(messages, [{ role: "assistant", content: "hello" }])
})

test("an assistant with no parts is empty, and several text parts stay separate", () => {
  const messages = conversationHistoryToCoreMessages({
    messages: [
      historyMessage("assistant", { content: [] }),
      historyMessage("assistant", { content: [
        { content: { case: "text", value: { text: "first" } } },
        { content: { case: "text", value: { text: "second" } } },
      ] }),
    ],
  })
  assert.deepEqual(messages, [
    { role: "assistant", content: "" },
    { role: "assistant", content: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ] },
  ])
})

test("several parts stay parts, with reasoning and tool calls restored", () => {
  const messages = conversationHistoryToCoreMessages({
    messages: [historyMessage("assistant", {
      content: [
        { content: { case: "text", value: { text: "thinking out loud" } } },
        { content: { case: "reasoning", value: { text: "because", signature: "sig" } } },
        { content: { case: "redactedReasoning", value: { data: "opaque" } } },
        { content: { case: "toolCall", value: { toolCallId: "c1", toolName: "shell", argsJson: '{"command":"ls"}' } } },
      ],
    })],
  })
  const content = messages[0]!.content as Array<Record<string, unknown>>
  assert.equal(content.length, 4)
  assert.deepEqual(content[1], { type: "reasoning", text: "because", signature: "sig" })
  assert.deepEqual(content[3], { type: "tool-call", toolCallId: "c1", toolName: "shell", args: { command: "ls" } })
})

test("a user image is wrapped as a data URL when it arrived bare", () => {
  const messages = conversationHistoryToCoreMessages({
    messages: [historyMessage("user", {
      content: [
        { content: { case: "image", value: { data: "AAAA", mimeType: "image/png" } } },
        { content: { case: "image", value: { data: "data:image/png;base64,BBBB", mimeType: "image/png" } } },
      ],
    })],
  })
  const content = messages[0]!.content as Array<{ image: string }>
  assert.equal(content[0]!.image, "data:image/png;base64,AAAA")
  assert.equal(content[1]!.image, "data:image/png;base64,BBBB")
})

test("a tool result keeps its text, its parts and its error flag", () => {
  const messages = conversationHistoryToCoreMessages({
    messages: [historyMessage("tool", {
      toolCallId: "c1",
      toolName: "shell",
      isError: true,
      content: [
        { content: { case: "text", value: { text: "line one" } } },
        { content: { case: "text", value: { text: "line two" } } },
        { content: { case: "image", value: { data: "data:image/png;base64,AAAA", mimeType: "image/png" } } },
      ],
    })],
  })
  const part = (messages[0]!.content as Array<Record<string, unknown>>)[0]!
  assert.equal(part.result, "line one\nline two")
  assert.equal(part.isError, true)
  assert.equal((part.experimental_content as Array<{ data?: string }>)[2]!.data, "AAAA")
})

test("an unknown content case is passed through rather than dropped", () => {
  for (const unknown of [{ case: "somethingNew", value: {} }, { case: "toString", value: {} }]) {
    const messages = conversationHistoryToCoreMessages({
      messages: [historyMessage("user", { content: [{ content: unknown }] })],
    })
    assert.deepEqual(messages[0]!.content, unknown)
  }
})

test("an unknown top-level message ends history conversion, and malformed tool-call JSON is rejected", () => {
  for (const unknownMessage of [
    { case: "futureRole", value: { opaque: true } },
    { case: "toString", value: { opaque: true } },
  ]) {
    assert.deepEqual(conversationHistoryToCoreMessages({ messages: [{ message: unknownMessage }] }), unknownMessage)
  }

  assert.throws(() => conversationHistoryToCoreMessages({
    messages: [historyMessage("assistant", { content: [{ content: { case: "toolCall", value: { argsJson: "{bad" } } }] })],
  }), SyntaxError)
})

test("an unknown tool-result part is kept as one experimental part", () => {
  const unknown = { case: "futurePart", value: { opaque: true } }
  const messages = conversationHistoryToCoreMessages({
    messages: [historyMessage("tool", {
      toolCallId: "c1",
      toolName: "future-tool",
      content: [{ content: unknown }],
    })],
  })
  const result = (messages[0]!.content as Array<Record<string, unknown>>)[0]!
  assert.equal(result.result, undefined)
  assert.deepEqual(result.experimental_content, [unknown])
})

test("no history at all is no messages", () => {
  assert.deepEqual(conversationHistoryToCoreMessages(undefined), [])
})

// ---------------------------------------------------------------------------------------------
// the run's restore and checkpoint
// ---------------------------------------------------------------------------------------------

test("only the actions that change the kind of run keep that marker", () => {
  assert.equal(shouldTrackAgentTypeChange("userMessageAction"), true)
  assert.equal(shouldTrackAgentTypeChange("executePlanAction"), true)
  assert.equal(shouldTrackAgentTypeChange("someOtherAction"), false)
  assert.equal(shouldTrackAgentTypeChange(undefined), false)
})

test("the runner's restore controls are added without losing the caller's options", () => {
  const options = buildRunStreamStateHandleOptions({ shouldTrackAgentTypeChange: true }, {
    serializeSubagentStatesAsBlobRefs: true,
    agentStateRestoreBlobFetchConcurrency: 4,
  })
  assert.equal(options.shouldTrackAgentTypeChange, true)
  assert.equal(options.serializeSubagentStatesAsBlobRefs, true)
  assert.equal(options.restoreBlobFetchConcurrency, 4)
  assert.equal(buildRunStreamStateHandleOptions({}, undefined).serializeSubagentStatesAsBlobRefs, false)
})

test("the checkpoint flushes the blobs first and hands the state on unredacted", async () => {
  const order: string[] = []
  const update = createRunStreamStateUpdateWithFlush({
    blobStore: {
      flush: async () => {
        order.push("flush")
      },
    },
    onStateUpdate: async (_ctx, state) => {
      order.push("state")
      assert.notEqual(state, undefined)
    },
  })
  // A real redacted state, so the decode the checkpoint performs is exercised rather than skipped.
  await update(ctx(), toRedactedConversationStateStructure(new ConversationStateStructure(), PrivacyMode.UNSPECIFIED))
  assert.deepEqual(order, ["flush", "state"])
})

test("a checkpoint that fails is not the action's failure", async () => {
  const update = createRunStreamStateUpdateWithFlush({
    blobStore: {
      flush: async () => {
        throw new Error("disk gone")
      },
    },
    onStateUpdate: async () => {
      throw new Error("and this too")
    },
  })
  await update(ctx(), toRedactedConversationStateStructure(new ConversationStateStructure(), PrivacyMode.UNSPECIFIED))
})

// ---------------------------------------------------------------------------------------------
// a subscription notification as a user message
// ---------------------------------------------------------------------------------------------

test("a notification becomes a user message with the earlier ones prepended", async () => {
  const calls: unknown[][] = []
  const handler = new SubscriptionWakeupActionHandler({
    handle: async (...args: unknown[]) => {
      calls.push(args)
      return "handled"
    },
    handleSingleStep: async (...args: unknown[]) => {
      calls.push(args)
      return "single"
    },
    handleModelStep: async (...args: unknown[]) => {
      calls.push(args)
      return "model"
    },
  })
  const action = { _privacyMode: PrivacyMode.UNSPECIFIED, notifications: [{ n: 1 }, { n: 2 }] }
  assert.equal(await handler.handle(ctx(), action as never, {}, {}, {}, {}), "handled")
  assert.equal(await handler.handleSingleStep(ctx(), action as never, {}, {}, {}, {}), "single")
  assert.equal(await handler.handleModelStep(ctx(), action as never, {}, {}, {}, {}), "model")
  assert.equal(calls.length, 3)
  const options = calls[0]![6] as { forcePrependedUserMessages: boolean; maxPrependedUserMessages: number; isSyntheticWakeup: boolean }
  assert.deepEqual(options, {
    forcePrependedUserMessages: true,
    maxPrependedUserMessages: 2,
    isSyntheticWakeup: true,
  })
  assert.equal(handler.getUserMessageActionHandler().handle !== undefined, true)
})

test("a notification action with nothing in it is refused", async () => {
  const handler = new SubscriptionWakeupActionHandler({
    handle: async () => "handled",
    handleSingleStep: async () => "single",
    handleModelStep: async () => "model",
  })
  await assert.rejects(
    handler.handle(ctx(), { _privacyMode: PrivacyMode.UNSPECIFIED, notifications: [] } as never, {}, {}, {}, {}),
    /requires at least one notification/,
  )
})

// ---------------------------------------------------------------------------------------------
// self-summary constants
// ---------------------------------------------------------------------------------------------

test("the summarization prompts ask for what a continuation needs", () => {
  assert.equal(MAX_SELF_SUMMARY_RETRIES, 3)
  assert.equal(SELF_SUMMARY_NUM_TURNS, 1_000)
  assert.equal(SELF_SUMMARY_CONTEXT_WINDOW_FRACTION, 0.9)
  assert.match(SELF_SUMMARIZATION_PROMPT, /will only see the user's original query and your summary/)
  assert.match(SELF_SUMMARIZATION_PROMPT, /DO NOT call any tools/)
  assert.match(TAGGED_COMPACTION_INSTRUCTIONS, /<summary><\/summary>/)
  assert.match(DETAILED_COMPACTION_PROMPT, /<analysis>/)
  assert.match(DETAILED_COMPACTION_PROMPT, /preserved verbatim/)
})

// ---------------------------------------------------------------------------------------------
// attached pull requests
// ---------------------------------------------------------------------------------------------

const gitPullRequestPrompt = (overrides: Partial<GitPullRequestPromptInput> = {}): GitPullRequestPromptInput => ({
  number: 1,
  url: "",
  folderPath: "",
  summary: { kind: "absent" },
  ...overrides,
})

test("nothing is rendered when no pull request was attached", () => {
  assert.deepEqual(buildGitPullRequestsUserContent([]), { type: "text", text: "" })
})

test("a pull request is described with its branches, its size and its files", () => {
  const rendered = buildGitPullRequestsUserContent([
    gitPullRequestPrompt({
      number: 7,
      title: "Fix",
      url: "https://pr.test/7",
      folderPath: "/w/pr",
      summary: {
        kind: "available",
        value: {
          headBranch: "feature",
          baseBranch: "main",
          description: "A change",
          totalFiles: 2,
          totalDiffLines: 30,
          diffCharacters: 900,
          files: [
            { path: "src/a.ts", changeKind: "modified", changedLines: 20, diffCharacters: 600, originalCharacters: 100 },
            { path: "src/b.ts", diffFileName: "custom.diff", changeKind: "added", changedLines: 10, diffCharacters: 300 },
          ],
        },
      },
    }),
  ])
  assert.match(rendered.text, /^<attached_pull_requests>/)
  assert.match(rendered.text, /Attached Pull Request:/)
  assert.match(rendered.text, /PR #7: Fix/)
  assert.match(rendered.text, /Branch: feature → main/)
  assert.match(rendered.text, /- Summary: 2 files, 30 lines, 900 chars/)
  assert.match(rendered.text, /src\/a\.ts \(diff: diffs\/src__a\.ts\.diff\)/)
  assert.match(rendered.text, /modified, 20 diff lines, 600 diff chars, 100 original chars/)
  assert.match(rendered.text, /src\/b\.ts \(diff: diffs\/custom\.diff\)/)
})

test("a long description is cut and points at the full one", () => {
  const rendered = buildGitPullRequestsUserContent([gitPullRequestPrompt({
    summary: {
      kind: "available",
      value: { description: "x".repeat(600), totalFiles: 1, totalDiffLines: 1, diffCharacters: 1 },
    },
  })])
  assert.match(rendered.text, /truncated, full description in summary\.json/)
  assert.equal(rendered.text.includes("x".repeat(600)), false)
})

test("a summary that does not parse falls back to describing the folder", () => {
  const rendered = buildGitPullRequestsUserContent([
    gitPullRequestPrompt({ folderPath: "/w/pr", summary: { kind: "invalid" } }),
  ])
  assert.match(rendered.text, /PR details are available in the folder \/w\/pr/)
  assert.match(rendered.text, /Read summary\.json/)
})

test("a pull request with no summary still names the folder and its contents", () => {
  const rendered = buildGitPullRequestsUserContent([
    gitPullRequestPrompt({ number: 2, folderPath: "/w/pr2" }),
  ])
  assert.match(rendered.text, /PR #2/)
  assert.match(rendered.text, /all\.diff/)
  assert.match(rendered.text, /summary\.json/)
})

test("several pull requests are separated and named in the plural", () => {
  const rendered = buildGitPullRequestsUserContent([
    gitPullRequestPrompt({ number: 1 }),
    gitPullRequestPrompt({ number: 2 }),
  ])
  assert.match(rendered.text, /Attached Pull Requests:/)
  assert.match(rendered.text, /PR #1[\s\S]*PR #2/)
})

// ---------------------------------------------------------------------------------------------
// the todo list
// ---------------------------------------------------------------------------------------------

test("a todo status goes both ways", () => {
  assert.equal(stringToTodoStatus("pending"), "pending")
  assert.equal(stringToTodoStatus("in_progress"), "in_progress")
  assert.equal(stringToTodoStatus("completed"), "completed")
  assert.equal(stringToTodoStatus("cancelled"), "cancelled")
  assert.equal(todoStatusToString("pending"), "pending")
  assert.equal(todoStatusToString("cancelled"), "cancelled")
  assert.equal(todoStatusToString("unspecified"), "unspecified")
})

test("an item keeps the content and creation time it did not restate", () => {
  const existing = {
    id: "t1",
    content: "old content",
    status: "pending" as const,
    createdAt: 5n,
    updatedAt: 5n,
  }
  const kept = createTodoItem({ id: "t1", status: "in_progress" }, existing)
  assert.equal(kept.content, "old content")
  assert.equal(kept.createdAt, 5n)
  assert.equal(kept.status, "in_progress")

  const fresh = createTodoItem({ id: "t2", content: "new", status: "pending" })
  assert.equal(fresh.content, "new")
  assert.ok(fresh.createdAt > 0n)
})

test("the list is summarized with its statuses and ids", () => {
  assert.equal(formatTodosForSummarization([]), undefined)
  const summarized = formatTodosForSummarization([
    { id: "t1", content: "do it", status: "in_progress", createdAt: 1n, updatedAt: 1n },
  ])
  assert.equal(summarized, "- **IN_PROGRESS**: do it (id: t1)")
})

test("each complete streamed item is shown as the list so far", () => {
  const emitted: unknown[] = []
  const { parser, streamedTodos } = createStreamingTodoParser(
    ctx(),
    {
      emitPartialToolCall: (_ctx, toolCallId, toolCall) => {
        emitted.push({ toolCallId, toolCall })
      },
    },
    { toolCallId: "call-1" },
    new Map(),
  )
  parser.write('{"todos":[{"id":"t1","content":"first","status":"pending"},')
  assert.equal(streamedTodos.length, 1)
  assert.equal(emitted.length, 1)
  parser.write('{"id":"t2","content":"second","status":"completed"}]}')
  assert.equal(streamedTodos.length, 2)
  assert.equal(emitted.length, 2)
  const last = emitted.at(-1) as { toolCall: { args?: { todos?: readonly unknown[] } } }
  assert.equal(last.toolCall.args?.todos?.length, 2)
})
