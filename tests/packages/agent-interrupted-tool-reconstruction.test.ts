import { test } from "node:test"
import assert from "node:assert/strict"

import { buildInterruptedPendingToolCallMessages } from "../../source/packages/agent/actions/user-message-action/interrupted-tool-reconstruction.ts"
import { getExecutableTools } from "../../source/packages/agent/tools/tool-execution.ts"
import { appendInterruptedShellOutputSnapshot, getInterruptedShellOutputSnapshot } from "../../source/packages/agent/tools/core/shell/interrupted-shell-output.ts"
import { fromRedactedCoreMessage } from "../../source/packages/redaction/message-redaction.ts"
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import {
  InterruptedPendingToolCallResolution,
  InterruptedPendingToolCallResolutions,
  TaskError,
  TaskResult,
} from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import { ShellResult, ShellSuccess } from "../../source/packages/proto/generated/agent/v1/shell_exec_pb.ts"
import { toRedactedInterruptedPendingToolCallResolution } from "../../source/packages/redacted-protos/generated/agent/v1/agent_redacted.ts"

// ---------------------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------------------

interface PendingMessageLike {
  unwrap(): string
}

const TOOLS = getExecutableTools({
  modelVisibleTools: [{ name: "Shell", toolIdentifier: "SHELL" }, { name: "Await", toolIdentifier: "AWAIT" }, { name: "Read", toolIdentifier: "READ" }] as never,
  additionalExecutableTools: [],
})

const assistantMessage = (content: unknown[], options: { startedAtMs?: number; role?: string } = {}) => JSON.stringify({
  role: options.role ?? "assistant",
  content,
  ...(options.startedAtMs === undefined ? {} : { providerOptions: { cursor: { pendingToolCallStartedAtMs: options.startedAtMs } } }),
})

const toolCall = (toolCallId: string, toolName: string) => ({ type: "tool-call", toolCallId, toolName, args: "{}" })

function harness(messages: Array<string | unknown>, options: {
  resolutions?: InterruptedPendingToolCallResolutions
  terminalsFolder?: string
} = {}) {
  const raw: PendingMessageLike[] = messages.map(message => ({
    unwrap: () => (typeof message === "string" ? message : JSON.stringify(message)),
  }))
  return buildInterruptedPendingToolCallMessages(
    { getRawPendingMessages: () => raw, getPrivacyMode: () => PrivacyMode.NO_STORAGE },
    TOOLS,
    options.resolutions,
    options.terminalsFolder ?? "/repo/.slate/projects/workspace-1/terminals",
  )
}

/** The messages as plain values, which is what a caller of the builder sees. */
const readBack = (messages: ReturnType<typeof buildInterruptedPendingToolCallMessages>) =>
  messages.map(message => fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) as Record<string, unknown>)

const toolMessageOf = (messages: ReturnType<typeof buildInterruptedPendingToolCallMessages>) => {
  const tool = readBack(messages).find(message => message.role === "tool")
  assert.notEqual(tool, undefined)
  return tool as { content: Array<Record<string, unknown>>; providerOptions: { cursor: { highLevelToolCallResult: { output: string[]; isError: boolean; rawErrorMessages: string[] } } } }
}

const resolutionFor = (toolCallId: string, resolution: InterruptedPendingToolCallResolution["resolution"]) =>
  new InterruptedPendingToolCallResolutions({
    resolutions: [toRedactedInterruptedPendingToolCallResolution(
      new InterruptedPendingToolCallResolution({ toolCallId, resolution }),
      PrivacyMode.NO_STORAGE,
    ) as never],
  })

// ---------------------------------------------------------------------------------------------
// nothing to repair
// ---------------------------------------------------------------------------------------------

test("a conversation with nothing pending is left alone", () => {
  assert.deepEqual(harness([]), [])
})

test("a pending message that cannot be read back is left out", () => {
  assert.deepEqual(harness(["not json at all"]), [])
})

test("an assistant message with no tool call is passed through unanswered", () => {
  const messages = readBack(harness([assistantMessage([{ type: "text", text: "thinking" }])]))
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.role, "assistant")
})

test("a message that is not from the assistant is passed through unanswered", () => {
  const messages = readBack(harness([JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] })]))
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.role, "user")
})

// ---------------------------------------------------------------------------------------------
// reconstructing a result
// ---------------------------------------------------------------------------------------------

test("an interrupted tool call is answered with what it was and how long it ran", () => {
  const startedAtMs = Date.now() - 4_000
  const messages = harness([assistantMessage([toolCall("call-1", "Read")], { startedAtMs })])
  const tool = toolMessageOf(messages)
  assert.equal(tool.content.length, 1)
  const entry = tool.content[0] as Record<string, unknown>
  assert.equal(entry.type, "tool-result")
  assert.equal(entry.toolCallId, "call-1")
  assert.equal(entry.toolName, "Read")
  assert.match(String(entry.result), /^Error: Read was interrupted by the user after \d+ms before it completed\.$/)
  // The text part is what a provider that cannot read the structured result shows.
  assert.deepEqual(entry.experimental_content, [{ type: "text", text: entry.result }])
})

test("a tool call with no start time is answered without one", () => {
  const tool = toolMessageOf(harness([assistantMessage([toolCall("call-1", "Read")])]))
  assert.equal((tool.content[0] as Record<string, unknown>).result, "Error: Read was interrupted by the user before it completed.")
})

test("an interrupted wait says it was a wait", () => {
  const tool = toolMessageOf(harness([assistantMessage([toolCall("call-1", "Await")], { startedAtMs: Date.now() - 1_000 })]))
  assert.match(String((tool.content[0] as Record<string, unknown>).result), /^Error: Await was interrupted by the user after \d+ms\.$/)
})

test("an interrupted shell command is answered with the output it had produced", () => {
  appendInterruptedShellOutputSnapshot("call-1", "building...\n")
  const messages = harness([assistantMessage([toolCall("call-1", "Shell")])])
  const result = String((toolMessageOf(messages).content[0] as Record<string, unknown>).result)
  assert.match(result, /^Error: Shell command was interrupted by the user before it completed\./)
  assert.match(result, /Output collected before interruption/)
  assert.match(result, /building\.\.\./)
  // The snapshot is taken once: a later reconstruction of the same call has no output to quote.
  assert.equal(getInterruptedShellOutputSnapshot("call-1"), undefined)
})

test("an interrupted shell command with no output says only that it was interrupted", () => {
  const tool = toolMessageOf(harness([assistantMessage([toolCall("call-1", "Shell")])]))
  assert.equal((tool.content[0] as Record<string, unknown>).result, "Error: Shell command was interrupted by the user before it completed.")
})

test("several tool calls in one message are each answered", () => {
  const messages = harness([assistantMessage([toolCall("call-1", "Read"), toolCall("call-2", "Shell")])])
  const tool = toolMessageOf(messages)
  assert.deepEqual(tool.content.map(entry => entry.toolCallId), ["call-1", "call-2"])
  assert.equal(tool.providerOptions.cursor.highLevelToolCallResult.rawErrorMessages.length, 2)
  assert.equal(tool.providerOptions.cursor.highLevelToolCallResult.isError, true)
})

test("an entry that is not a tool call is ignored", () => {
  const messages = harness([assistantMessage([{ type: "text", text: "let me look" }, toolCall("call-1", "Read")])])
  assert.equal(toolMessageOf(messages).content.length, 1)
})

test("a tool call without an id or a name is ignored", () => {
  const messages = harness([assistantMessage([{ type: "tool-call", toolCallId: 7, toolName: "Read" }, { type: "tool-call", toolCallId: "call-1" }])])
  assert.equal(readBack(messages).length, 1)
})

// ---------------------------------------------------------------------------------------------
// the host's own record
// ---------------------------------------------------------------------------------------------

test("a recorded shell result is rendered as the result the model reads", () => {
  const resolutions = resolutionFor("call-1", {
    case: "shellResult",
    value: new ShellResult({
      result: { case: "success", value: new ShellSuccess({ shellId: 3, command: "npm test", stdout: "ok", exitCode: 0 } as never) },
      isBackground: true,
    }),
  })
  const tool = toolMessageOf(harness([assistantMessage([toolCall("call-1", "Shell")])], { resolutions }))
  const entry = tool.content[0] as Record<string, unknown>
  assert.match(String(entry.result), /Background command started successfully/)
  // The folder the session uses fills in the one the recorded result did not carry.
  assert.match(String(entry.result), /\/repo\/\.slate\/projects\/workspace-1\/terminals\/3\.txt/)
  // A recorded success is not an error, so it is not repeated among the raw error messages.
  assert.deepEqual(tool.providerOptions.cursor.highLevelToolCallResult.rawErrorMessages, [])
  assert.equal(tool.providerOptions.cursor.highLevelToolCallResult.isError, false)
})

test("a recorded shell failure is reported as an error", () => {
  const resolutions = resolutionFor("call-1", {
    case: "shellResult",
    value: new ShellResult({ result: { case: "rejected", value: {} } as never }),
  })
  const tool = toolMessageOf(harness([assistantMessage([toolCall("call-1", "Shell")])], { resolutions }))
  assert.match(String((tool.content[0] as Record<string, unknown>).result), /^Rejected: /)
  assert.equal(tool.providerOptions.cursor.highLevelToolCallResult.isError, true)
})

test("a recorded shell result with no outcome is an unknown error", () => {
  const resolutions = resolutionFor("call-1", { case: "shellResult", value: new ShellResult() })
  const tool = toolMessageOf(harness([assistantMessage([toolCall("call-1", "Shell")])], { resolutions }))
  assert.equal((tool.content[0] as Record<string, unknown>).result, "Unknown error")
  assert.equal(tool.providerOptions.cursor.highLevelToolCallResult.isError, true)
})

test("a recorded subagent result is rendered as a finished subagent's", () => {
  const resolutions = resolutionFor("call-1", {
    case: "taskResult",
    value: new TaskResult({ result: { case: "error", value: new TaskError({ error: "the subagent died" }) } }),
  })
  const tool = toolMessageOf(harness([assistantMessage([toolCall("call-1", "Task")])], { resolutions }))
  assert.equal((tool.content[0] as Record<string, unknown>).result, "Error: the subagent died")
  assert.equal(tool.providerOptions.cursor.highLevelToolCallResult.isError, true)
})

test("a record for another call does not answer this one", () => {
  const resolutions = resolutionFor("call-9", {
    case: "taskResult",
    value: new TaskResult({ result: { case: "error", value: new TaskError({ error: "the subagent died" }) } }),
  })
  const tool = toolMessageOf(harness([assistantMessage([toolCall("call-1", "Read")])], { resolutions }))
  assert.match(String((tool.content[0] as Record<string, unknown>).result), /^Error: Read was interrupted/)
})

test("a record with no outcome at all falls back to the reconstruction", () => {
  const resolutions = resolutionFor("call-1", { case: undefined })
  const tool = toolMessageOf(harness([assistantMessage([toolCall("call-1", "Read")])], { resolutions }))
  assert.match(String((tool.content[0] as Record<string, unknown>).result), /^Error: Read was interrupted/)
})

// ---------------------------------------------------------------------------------------------
// what the caller gets back
// ---------------------------------------------------------------------------------------------

test("the answer is appended as a tool message the host can read", () => {
  const messages = harness([
    assistantMessage([toolCall("call-1", "Read")]),
    assistantMessage([toolCall("call-2", "Read")]),
  ])
  const read = readBack(messages)
  assert.deepEqual(read.map(message => message.role), ["assistant", "tool", "assistant", "tool"])
  const tool = toolMessageOf(messages)
  assert.deepEqual(tool.providerOptions.cursor.highLevelToolCallResult.output, tool.content.map(entry => entry.result))
})

test("every appended message is redacted for storage", () => {
  const messages = harness([assistantMessage([toolCall("call-1", "Read")])])
  assert.equal(messages.length, 2)
  for (const message of messages) {
    assert.equal(typeof (message as { _privacyMode?: unknown })._privacyMode, "number")
  }
})

test("an interrupted call reports how long it had been running", () => {
  const messages = harness([assistantMessage([toolCall("call-elapsed", "Await")], { startedAtMs: 42 })])
  const tool = toolMessageOf(messages) as unknown as { content: Array<{ result: string }> }
  const result = tool.content[0]!.result
  assert.equal(/after [0-9]+ms/.test(result), true)
  assert.equal(result.includes("after 0ms"), false)
})

test("an unknown tool is reported by its own name", () => {
  const messages = harness([assistantMessage([toolCall("call-unknown", "Mystery")])])
  const tool = toolMessageOf(messages) as unknown as { content: Array<{ result: string }> }
  const result = tool.content[0]!.result
  assert.equal(result.includes("Mystery was interrupted"), true)
  assert.equal(result.includes("Await was interrupted"), false)
})
